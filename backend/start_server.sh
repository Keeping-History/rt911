#!/bin/bash
yes | cp -rf .env.local .env
direnv allow . && eval "$(direnv export bash)"
./start_db.sh
docker-compose build
docker-compose up
