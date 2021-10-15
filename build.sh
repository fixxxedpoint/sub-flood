#!/bin/bash

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.38.0/install.sh | bash # install node version manager
exec bash # reloads bash after we installed nvm
nvm install # install dependencies
npm install yarn # install yarn
npm run build # build project
