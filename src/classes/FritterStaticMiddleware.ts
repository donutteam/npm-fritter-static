//
// Imports
//

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { FritterMiddlewareFunction } from "@fritter/core";
import isCompressible from "compressible";
import mimeTypes from "mime-types";

//
// Class
//

export interface FritterStaticMiddlewareDirectory
{
	/** Mount the directory to this path. */
	mountPath? : string;

	/** The path to the directory on disk. */
	path : string;
}

export interface FritterStaticMiddlewareFile
{
	onDiskFilePath : string;

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
	dirs : FritterStaticMiddlewareDirectory[];

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
	public readonly dirs : FritterStaticMiddlewareDirectory[];

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

			// Note: Uses posix, even on Windows, so paths always use forward slashes.
			let requestedFilePath = path.posix.normalize(decodeURIComponent(context.fritterRequest.getPath()));

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
					// Handle Mount Point
					//

					if (dir.mountPath != null)
					{
						if (!requestedFilePath.startsWith(dir.mountPath))
						{
							continue;
						}

						requestedFilePath = requestedFilePath.slice(dir.mountPath.length);
					}

					//
					// Build File Path
					//

					const onDiskFilePath = path.join(dir.path, requestedFilePath);

					//
					// Prevent Directory Traversal
					//

					if (!onDiskFilePath.startsWith(dir.path))
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

							modifiedDate: stats.mtime,

							size: stats.size,

							stats,

							type: mimeTypes.lookup(onDiskFilePath) || "application/octet-stream",
						};

					this.fileDataCache[requestedFilePath] = file;

					break;
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
			if (dir.mountPath != null)
			{
				if (!filePath.startsWith(dir.mountPath))
				{
					continue;
				}

				filePath = filePath.slice(dir.mountPath.length);
			}

			const onDiskPath = path.join(dir.path, filePath);

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