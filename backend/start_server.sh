#!/bin/bash
./start_db.sh
docker-compose build
docker-compose up
