#!/bin/bash
./build.sh
aws --profile=911realtime-frontend-editor s3 rm s3://www.911realtime.org/build --recursive
aws --profile=911realtime-frontend-editor s3 cp build/. s3://www.911realtime.org --recursive
