const fs = require("fs");
const path = require("path");

const source = path.join("anchor", "keys", "leash-keypair.json");
const destDir = path.join("anchor", "target", "deploy");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(source, path.join(destDir, "leash-keypair.json"));
