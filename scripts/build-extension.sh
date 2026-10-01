#!/bin/sh
# Build espocrm-extension/ into a zip installable via Administration > Extensions (or extension.php CLI).
set -eu
cd "$(dirname "$0")/../espocrm-extension"
mkdir -p ../dist
python -c "
import zipfile,os
z=zipfile.ZipFile('../dist/office-automation.zip','w',zipfile.ZIP_DEFLATED)
z.write('manifest.json')
for r,_,fs in os.walk('files'):
    for f in fs:
        if f!='.gitkeep': z.write(os.path.join(r,f))
print('built dist/office-automation.zip')"
