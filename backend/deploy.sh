#!/bin/bash
./start_db.sh
sleep 5
bash -c "pip3 install -r requirements.txt &&
python3 manage.py makemigrations &&
python3 manage.py collectstatic --noinput &&
python3 manage.py migrate &&
python3 manage.py shell -c 'from django.contrib.auth.models import User; User.objects.filter(email=\"rt911@robbiebyrd.com\").delete(); User.objects.create_superuser(\"rt911\", \"rt911@robbiebyrd.com\", \"rt911\")'"
gcloud app deploy -q --project=civil-clarity-280121
