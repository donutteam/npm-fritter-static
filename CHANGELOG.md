## 2.0.1
* Fixed a bug where mount paths did not work as expected on Windows.
	* This also fixes an unintended behaviour where `fileDataCache` used backslashes as a separator on Windows.

## 2.0.0

* Updating packages.
* Removing `eslint` and `@donutteam/eslint-config` dev dependencies.
* Making `@fritter/core` a peer dependency.
* Added the `FritterStaticMiddlewareDirectory` type in place of `string` on `dirs` when constructing an instance of the middleware.
	* This new interface allows you to optionally specify a `mountPath` property.

## 1.1.3

* Removing support for the ETag header.
* Updating packages.

## 1.1.2
Fixing a bug where files were incorrectly prioritized.

## 1.1.1
Tweaks to internal path logic.

## 1.1.0
Adding the `getCachedBustedPath` method. Useful for rendering pages.

## 1.0.0
Initial version.