# rt911

Project to collect multimedia from the September 11 Attacks and synchronize them into a common media player.

VISIT THE SITE AT https://911realtime.org

## Getting Started

The application is two parts:

1. The API - A Django application that serves a JSON file
2. The UI - A basic HTML5/Bootstrap/jQuery app to display the videos

### Prerequisites

1. Python 3
2. pip

### To start the backend CMS

1. Clone this repo to your local machine.
2. Make sure to install Docker, docker-compose, and the Google Cloud SDK.
3. Open a terminal and change into the root of the repo.
4. From a command line, run the following commands:

```
cd backend
./start_server.sh
```

5. Open <http://0.0.0.0:8001> in your browser.

6. If you are using an Apple Silicon Mac, you may need to install mysqlclient separately. See https://stackoverflow.com/questions/66669728/trouble-installing-mysql-client-on-mac

### To start the frontend CMS

1. Open a terminal and change into the root of the repo.
2. From a command line, run the following commands:

```
cd frontend
./build.sh
./start_server.sh
```

3. Visit <http://127.0.0.1:8000> in your browser.

## SEE IT IN ACTION

### The UI

<https://www.911realtime.org>

### The CMS

<https://admin.911realtime.org/admin>
*Username*: rt911view
*Password*: R34lt1m3V13w5

## Special Thanks
Chris Wooster
Sergey Kochergan
Kori Stephens
Alison L. Roberts
Ryan M.
Richard Harms
Marina Harper
Matt MG Herron
Will Harris
Tristan Warsaw
Michael Locher
Ruthalas
James Wendel
Adil Majid
Jason Smith
Adros
Nikita Rogozov
Will Riches
Alana Malone
Cameron Murphy
Florence Arsenault
Brian Witt
Robinson Collado
Léon Spaans
Ben Romberg
Adam Garst
Greg
Tolu
David
Gus Gordon
Andrew Poirier
Ty Satrang
Carla Fuentes
Laura M. Macklin Baglien
