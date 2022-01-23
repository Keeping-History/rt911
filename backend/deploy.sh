#!/bin/bash
./start_db.sh
sleep 10
bash -c "pip3 install -r requirements.txt &&
python3 manage.py makemigrations &&
python3 manage.py collectstatic --noinput &&
python3 manage.py migrate"

if [ ! -f .env ]
then
    export $(cat .env | xargs)
fi

gcloud app deploy -q --project=$GOOGLE_CLOUD_PROJECT
