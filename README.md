# rt911

Project to collect multimedia from the September 11 Attacks and synchronize them into a common media player.

## Getting Started

The application is two parts:
1. The API - A Django application that serves a JSON file
2. The UI - A basic HTML5/Bootstrap/jQuery app to display the videos

###To start the backend CMS:
1. Clone this repo to your local machine.
2. Make sure to install Docker, docker-compose, and the Google Cloud SDK.
3. Open a terminal and change into the root of the repo.
4. From a command line, run the following commands: 
```cd backend
./start_db.sh
docker-compose build
docker-compose up
```
5. Open http://0.0.0.0:8000 in your browser.

###To start the frontend CMS:
<<<<<<< HEAD
1. Make sure to install Docker, docker-compose, and the Google Cloud SDK.
2. Open a terminal and change into the root of the repo.
3. From a command line, run the following commands: 
```cd frontend
./start_server
```
4. Visit http://127.0.0.1:8000 in your browser.
=======
2. Make sure to install Docker, docker-compose, and the Google Cloud SDK.
3. Open a terminal and change into the root of the repo.
4. From a command line, run the following commands: 
```cd frontend
./start_server
```
5. Visit http://127.0.0.1:8000 in your browser.
>>>>>>> 2dfc4b421abf2fc5abfb2a4f02b1a9924cd44f8e


## SEE IT IN ACTION
### The UI
http://www.911realtime.org

### The CMS
http://admin.911realtime.org/admin
Username: rt911view
Password: R34lt1m3V13w5