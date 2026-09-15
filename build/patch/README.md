# patch/

Mirror of the device rootfs. Anything placed here is copied into the system
image, replacing whatever is already at that path.

```
patch/www/views/gl-sdk4-ui-home.common.js.gz     -> /www/views/...
patch/www/i18n/gl-sdk4-ui-home.en.json           -> /www/i18n/...
patch/etc/gl_screen/config/product/ndpr/layout   -> /etc/gl_screen/...
patch/etc/gl_screen/image/wifi.png               -> /etc/gl_screen/image/...
```

File modes and symlinks are preserved; ownership is forced to `root:root`.
Web UI bundles are gzipped — `gunzip`, edit, `gzip` back before dropping the
file here.

`.delete` lists paths to remove from the image, one per line.

`README.md`, `.delete` and `.DS_Store` are never copied.
