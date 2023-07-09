//
// Imports
//

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { FritterMiddlewareFunction } from "@fritter/core";
import isCompressible from "compressible";
import mimeTypes from "mime-types";

//
// Class
//

export interface FritterStaticMiddlewareFile
{
	onDiskFilePath : string;

	md5 : string;

	modifiedDate : Date;

	size : number;

	stats : fs.Stats;

	type : string;
}

/** Options for constructing a new instance of the static middleware. */
export interface FritterStaticMiddlewareOptions
{
	/** The value of the Cache-Control header. Overrides maxAge. */
	cacheControlHeader? : string;

	/** One or more directories to serve files from, prioritized from first to last if files exist in multiple directories. */
	dirs : string[];

	/** Whether to enable gzip compression. */
	enableGzip? : boolean;

	/** The maximum age of the cache in seconds. */
	maxAge? : number;
}

/** A class for constructing middlewares that serve static files. */
export class FritterStaticMiddleware
{
	/** The value of the Cache-Control header. */
	public readonly cacheControlHeader : string;

	/** One or more directories to serve files from, prioritized from first to last if files exist in multiple directories. */
	public readonly dirs : string[];

	/** Whether to enable gzip compression. */
	public readonly enableGzip : boolean;

	/** The maximum age of the cache in seconds. */
	public readonly maxAge : number;

	/** The middleware function. */
	public readonly execute : FritterMiddlewareFunction;

	/** A cache of file data. */
	public readonly fileDataCache : { [filePath : string] : FritterStaticMiddlewareFile } = {};

	/** Constructs a new instance of the middleware. */
	constructor(options : FritterStaticMiddlewareOptions)
	{
		//
		// Default Options
		//

		this.dirs = options.dirs;

		this.enableGzip = options.enableGzip ?? true;

		this.maxAge = options.maxAge ?? 0;

		this.cacheControlHeader = options.cacheControlHeader ?? "public, max-age=" + this.maxAge;

		//
		// Create Middleware
		//

		this.execute = async (context, next) =>
		{
			//
			// Check Method
			//

			if (context.fritterRequest.getHttpMethod() != "GET" && context.fritterRequest.getHttpMethod() != "HEAD")
			{
				return await next();
			}

			//
			// Get Path
			//

			let requestedFilePath = path.normalize(decodeURIComponent(context.fritterRequest.getPath()));

			if (path.basename(requestedFilePath) == ".")
			{
				return await next();
			}

			//
			// Get File Data from Cache
			//

			let file = this.fileDataCache[requestedFilePath];

			//
			// Load File Data (if not cached)
			//

			if (file == null)
			{
				//
				// Iterate Directories
				//

				for (const dir of this.dirs)
				{
					//
					// Build File Path
					//

					const onDiskFilePath = path.join(dir, requestedFilePath);

					//
					// Prevent Directory Traversal
					//

					if (!onDiskFilePath.startsWith(dir))
					{
						return await next();
					}

					//
					// Get File Stats
					//

					let stats : fs.Stats;

					try
					{
						stats = await fs.promises.stat(onDiskFilePath);
					}
					catch (error)
					{
						continue;
					}

					if (!stats.isFile())
					{
						continue;
					}

					//
					// Create File Data
					//

					file =
						{
							onDiskFilePath,

							md5: crypto.createHash("md5").update(await fs.promises.readFile(onDiskFilePath)).digest("hex"),

							modifiedDate: stats.mtime,

							size: stats.size,

							stats,

							type: mimeTypes.lookup(onDiskFilePath) || "application/octet-stream",
						};

					this.fileDataCache[requestedFilePath] = file;
				}

				if (file == null)
				{
					return await next();
				}
			}

			//
			// Check On Disk File Modified Date
			//

			const stats = await fs.promises.stat(file.onDiskFilePath);

			if (stats.mtimeMs != file.stats.mtimeMs)
			{
				file.md5 = crypto.createHash("md5").update(await fs.promises.readFile(file.onDiskFilePath)).digest("hex");

				file.modifiedDate = stats.mtime;

				file.size = stats.size;

				file.stats = stats;

				file.type = mimeTypes.lookup(file.onDiskFilePath) || "application/octet-stream";
			}

			//
			// Response
			//

			context.fritterResponse.setStatusCode(200);

			context.fritterResponse.setLastModified(file.modifiedDate);

			context.fritterResponse.setEntityTag(file.md5);

			if (this.enableGzip)
			{
				context.fritterResponse.appendVaryHeaderName("Accept-Encoding");
			}

			if (context.fritterRequest.isFresh())
			{
				context.fritterResponse.setStatusCode(304);

				return;
			}

			context.fritterResponse.setContentType(file.type);

			context.fritterResponse.setContentLength(file.size);

			context.fritterResponse.setHeaderValue("Cache-Control", this.cacheControlHeader);

			context.fritterResponse.setHeaderValue("Content-MD5", file.md5);

			if (context.fritterRequest.getHttpMethod() == "HEAD")
			{
				return;
			}

			const readStream = fs.createReadStream(file.onDiskFilePath);

			context.fritterResponse.setBody(readStream);

			const acceptsGzip = context.fritterRequest.getAccepts().encoding("gzip") != null;

			const shouldGzip = this.enableGzip && file.size > 1024 && isCompressible(file.type);

			if (acceptsGzip && shouldGzip)
			{
				context.fritterResponse.removeHeaderValue("Content-Length");

				context.fritterResponse.setHeaderValue("Content-Encoding", "gzip");

				context.fritterResponse.setBody(readStream.pipe(zlib.createGzip()));
			}
			else
			{
				context.fritterResponse.setBody(readStream);
			}
		};
	}

	/** Returns a path with a cache-busting query string appended. */
	public getCacheBustedPath(filePath : string) : string
	{
		const file = this.fileDataCache[filePath];

		if (file != null)
		{
			return filePath + "?mtime=" + file.stats.mtimeMs;
		}

		for (const dir of this.dirs)
		{
			const onDiskPath = path.join(dir, filePath);

			try
			{
				// HACK: Don't use statSync here
				const stats = fs.statSync(onDiskPath);

				let modifiedTimestamp = stats.mtime.getTime();

				return filePath + "?mtime=" + modifiedTimestamp.toString();
			}
			catch (error)
			{
				// Note: Doesn't matter if this fails, that just means it doesn't exist.
			}
		}

		return filePath;
	}
}