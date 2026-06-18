@echo off

set ELECTRON_BUILDER_BINARIES_DIR=%cd%\vendor\builder
set ELECTRON_BUILDER_OFFLINE=true
set CSC_IDENTITY_AUTO_DISCOVERY=false
set ELECTRON_OVERRIDE_DIST_PATH=%cd%\vendor\electron\electron-v42.3.0-win32-x64

npm run build
