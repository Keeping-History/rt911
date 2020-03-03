// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Easter Time, and runs to 11:59:59 PM the same day.
//

remoteurl = "http://54.87.47.88:8080/videos/";
start = "08:31:00";

var data = (function() {
    var result;
    $.ajax({
        type: 'GET',
        url: remoteurl,
        dataType: 'json',
        async: false,
        success: function(data) {
            result = data;
        }
    });
    return result;
})();

// Attach the media timeline to an HTML5 player
// The player will control the current 'time' of the sim
var timekeeper = document.getElementById('timekeeper');
timekeeper.setAttribute("autoplay", "");

// When the timkekeeper is loaded, jump to the start point,
// load the videos and then pause, ready for play.
timekeeper.addEventListener('canplay', function() {
    jumpIt(start);
    var players = document.querySelectorAll('#videos * video, #videoplayermain video');
    for (let player of players) {
        player.pause();
    }
}, false);

// Events for the main timeline controller
// When the timeline is seeked, then update the play location of the child video players
timekeeper.addEventListener('seeked', function() {
    var players = document.querySelectorAll('#videos * video, #videoplayermain video');
    for (let player of players) {
        var dataItem = data.find(data => data.vidid === player.id);
        player.currentTime = johng.timestamp() - hmsToSeconds(dataItem.start);
    }
}, false);

// When the timeline controller is playing, make sure the child video players are running
timekeeper.addEventListener('play', function() {
    var players = document.querySelectorAll('#videos * video, #videoplayermain video');
    for (let player of players) {
        player.play();
    }
}, false);

// When the timeline controller is paused, make sure the child video players also pause
timekeeper.addEventListener('pause', function() {
    var players = document.querySelectorAll('#videos * video, #videoplayermain video');
    for (let player of players) {
        player.pause();
    }
}, false);


// Boilerplate code to load our framework, memento.js
var johng = memento();

// Attach our memento object to our timekeeper audio player
johng.node(timekeeper);

// Load in the johng data
johng.all_data(data);

// Initialize the tracker
johng();

johng.tick(true, function(activeVideos, timestamp) {

    // Every time the media player's time changes, this function weill be called

    // Set some variables
    let activePlayersList = [];
    let activeVideosList = [];

    // We slice the activePlayers list so we can an Array instead of an HTMLCollection
    activePlayers = Array.prototype.slice.call(document.querySelectorAll('#videos * video, #videoplayermain video'));

    // The activeVideos is passed in to the function each time it is run
    if (Array.isArray(activeVideos)) {
        activeVideos.forEach(function(thisVideo) {
            activeVideosList.push(thisVideo.vidid);
        })
    }

    if (Array.isArray(activePlayers)) {
        activePlayers.forEach(function(thisPlayer) {
            activePlayersList.push(thisPlayer.id);
        })
    }

    // Show which players are not active but should be added
    let addPlayers = activeVideosList.filter(x => !activePlayersList.includes(x));

    // And add them
    if (Array.isArray(addPlayers)) {
        // Ok, so addPlayers is an actual Array, so we can loop over it
        addPlayers.forEach(
            function(playerId) {

                // Does a player window with the same ID already exist?
                var doesPlayerExist = document.getElementById(playerId);

                if (!doesPlayerExist) {
                    // Grab the video data item because we need it
                    var dataItem = data.find(data => data.vidid === playerId);

                    // If not, then let's create a container...
                    var newPlayerContainer = document.createElement('div');
                    newPlayerContainer.setAttribute("id", playerId + '_div');

                    // ... and a player for our video
                    var newPlayer = document.createElement('video');
                    newPlayer.controls = false;
                    newPlayer.setAttribute("id", playerId);

                    // Create a title
                    var newPlayerTitle = document.createElement("h2");
                    newPlayerTitle.appendChild(document.createTextNode(dataItem.source));
                    newPlayerTitle.setAttribute("id", playerId + '_title');

                    // Add video object and title we just created to DOM
                    newPlayerContainer.appendChild(newPlayerTitle)
                    newPlayerContainer.appendChild(newPlayer)

                    document.querySelector("#videos").appendChild(newPlayerContainer);

                    // Create a source element for the video player
                    var source = document.createElement('source');
                    source.src = dataItem.url;

                    // Append the source element to the video player
                    newPlayer.appendChild(source);

                    // When mousing over a player, unmute it so we can hear.
                    newPlayerContainer.addEventListener("mouseover", function() {
                        document.getElementById(playerId).muted = false;
                    });

                    // When mousing out of a player, mute it again,
                    // unless it is our main video, in which case don't mute.
                    newPlayerContainer.addEventListener("mouseout", function() {
                        if (document.getElementById(playerId + '_div').classList.contains("highlight")) {
                            document.getElementById(playerId).muted = false;
                        } else {
                            document.getElementById(playerId).muted = true;
                        }
                    });

                    // When clicking a player, make it the main video player,
                    newPlayerContainer.addEventListener("click", function() {

                        $('#videoplayermain').children().prependTo("#videos");

                        if (document.getElementById(playerId + '_div').classList.contains("highlight")) {
                            document.getElementById(playerId + '_div').classList.remove("highlight")
                            document.getElementById(playerId).muted = true;
                        } else {
                            var container = document.querySelector("#videos");
                            matches = container.querySelectorAll('div.highlight')

                            matches.forEach(function(item) {
                                item.classList.remove("highlight");
                            });

                            document.getElementById(playerId + '_div').classList.add("highlight");
                            document.getElementById(playerId).muted = false;
                            var element = $('#' + playerId + '_div').detach();
                            $('#videoplayermain').append(element);
                        }
                    });

                    newPlayer.currentTime = timestamp - hmsToSeconds(dataItem.start);

                    // When the player is ready to be played, check the timestamp and start at the appropriate time
                    newPlayer.oncanplay = function() {
                        this.play();
                        this.muted = true;
                    };
                }
            }
        )
    }

    // Show which players should be removed
    let removePlayers = activePlayersList.filter(x => !activeVideosList.includes(x));

    // And remove them
    if (Array.isArray(removePlayers)) {
        // We have some players that are no longer live and should be destroyed.
        removePlayers.forEach(
            function(playerId) {
                if (playerId) {
                    document.getElementById(playerId + "_div").remove();
                }
            })
    }
});

// Helper function to convert HH:MM:SS to Seconds
function hmsToSeconds(str) {
    var p = str.split(':'),
        s = 0,
        m = 1;
    while (p.length > 0) {
        s += m * parseInt(p.pop(), 10);
        m *= 60;
    }
    return s;
}

// Jump to the right timestamp
function jumpIt(str) {
    timekeeper.currentTime = hmsToSeconds(str)
}