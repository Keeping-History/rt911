#!/bin/bash
./build.sh
echo "Removing old builds..."
gsutil -m rm gs://$GOOGLE_CLOUD_BUCKET/**
echo "Uploading new build..."
gsutil -m cp -r build/* gs://$GOOGLE_CLOUD_BUCKET/
echo "Complete!"
