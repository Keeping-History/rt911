FROM python:3.6
ENV PYTHONUNBUFFERED 1
RUN mkdir /rt911
WORKDIR /rt911

ADD requirements.txt /rt911
RUN pip install --upgrade pip && pip install -r requirements.txt

ADD . /rt911

CMD [ "python3", "api/manage.py", "runserver", "0.0.0.0:8000" ]
