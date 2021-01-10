window.start = "08:46:39";

window.baseremoteurl = "https://api.911realtime.org/";
window.timekeeper = $('#timekeeper').get(0);

window.modals = []
// Boilerplate code to load our framework, memento.js
window.johng = memento();

// Attach our memento object to our timekeeper audio player
window.johng.node(window.timekeeper);

// This function loads the data into johng
updateTimelineData(window.data);

// Initialize the tracker
window.johng();

// Adds the base API URL and any URL filters and returns a full URL for AJAX calls
function getURL() {
    return window.baseremoteurl + "?" + $("#filters :input[value!='all']").serialize();
}

function moveTime(increment) {
    window.timekeeper.currentTime = window.timekeeper.currentTime + increment;
    pauseAllPlayers();
    playAllPlayers();
};

//getData this is the function that grabs the json via ajax
function getData() {
    var result;
    $.ajax({
        type: 'GET',
        url: getURL(),
        dataType: 'json',
        async: false,
        cache: true,
        success: function (data) {
            result = data;
        }
    });
    // TODO: Add localstorage caching here to prevent multiple calls to the endpoint
    window.data = result;
};

function getNetworks() {
    var result;
    $.ajax({
        type: 'GET',
        url: baseremoteurl + 'networks',
        dataType: 'json',
        async: false,
        cache: true,
        success: function (networks) {
            result = networks;
        }
    });
    // TODO: Add localstorage caching here to prevent multiple calls to the endpoint
    window.networks = result;
};

function hmsToSeconds(hmsString) {
    var a = hmsString.split(':'); // split it at the colons

    // minutes are worth 60 seconds. Hours are worth 60 minutes.
    var seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);

    return seconds;
}

function setReadMores() {
    $("#htmls div div").readmore({
        embedCSS: false,
        collapsedHeight: 0,
        speed: 75,
        lessLink: '<button class="command_button" type="button"><span class="btn-text"><a href="#">Read Less</a></span></button>',
        moreLink: '<button class="command_button" type="button"><span class="btn-text"><a href="#">Read More</a></span></button>',
        blockCSS: 'display: inline-block; float: right;'
    });
}

function isMediaReady(activeItems) {
    activeItems.forEach(element => {
        if (element.media_type == 'video') {
            $("#" + element.vidid).on('canplay', function () {
                console.log('canplay: ' + this);
            });
        }
    });
}

function isPlaying(playerId) {
    var player = document.getElementById(playerId);
    return !player.paused && !player.ended && 0 < player.currentTime;
}

// Jump to the right timestamp
function jumpIt(timeString) {
    window.timekeeper.currentTime = hmsToSeconds(timeString)
}

function addTimekeeperListeners() {
    // Attach the media timeline to an HTML5 player
    // The player will control the current 'time' of the sim
    window.timekeeper.setAttribute("autoplay", "false");

    // When the timkekeeper is loaded, jump to the start point,
    // load the videos and then pause, ready for play.
    $('#timekeeper').on('canplay', function () {
        jumpIt(window.start);
        setTimeAllPlayers();
        muteAudioPlayers();
        pauseAllPlayers();
    });

    // Events for the main timeline controller
    // When the timeline is seeked, then update the play location of the child video players
    window.timekeeper.addEventListener('seeked', function () {
        setTimeAllPlayers();
    }, false);

    // When the timeline controller is playing, make sure the child video players are running
    window.timekeeper.addEventListener('play', function () {
        setTimeAllPlayers();
        playAllPlayers();
    }, false);

    // When the timeline controller is paused, make sure the child video players also pause
    window.timekeeper.addEventListener('pause', function () {
        setTimeAllPlayers();
        pauseAllPlayers();
    }, false);
}

function updateNetworks() {
    window.networks.forEach(function (item) {
        $('#network').append($('<option>').text(item).attr('value', item));
    });
}


function removeItems(currentItemsList, activeItemsList) {
    // Show which players should be removed
    let removePlayers = currentItemsList.filter(x => !activeItemsList.includes(x));
    // And remove them
    if (Array.isArray(removePlayers)) {
        // We have some players that are no longer live and should be destroyed.
        removePlayers.forEach(
            function (playerId) {
                if (playerId) {
                    $('#' + playerId + '_div').remove();
                    $('#' + playerId + '_preload').remove();
                }
            })
    }
};

function updateData() {
    getNetworks();
    getData();
    updateNetworks();

    updateTimelineData(window.data);

    $('#timekeeper').trigger('pause');
}

function updateTimelineData(data) {
    window.johng.all_data(data);
}


function addItems(currentItemsList, activeItemsList) {
    // Show which players are not active but should be added
    let addMediaItems = activeItemsList.filter(x => !currentItemsList.includes(x));
    // And add them
    if (Array.isArray(addMediaItems)) {
        // Ok, so addMediaItems is an actual Array, so we can loop over it
        addMediaItems.forEach(
            function (playerId) {
                // Does a player window with the same ID already exist?
                var doesPlayerExist = document.getElementById(playerId);

                if (!doesPlayerExist) {
                    // Grab the video data item because we need it
                    var mediaItem = data.find(data => data.vidid === playerId);

                    switch (mediaItem.media_type) {

                        case 'video':
                            $("#videos").append(create_video(playerId, mediaItem));
                            break;

                        case 'audio':
                            $("#audios").append(create_audio(playerId, mediaItem));
                            break;

                        case 'html':
                            $("#htmls").append(create_html(playerId, mediaItem));
                            break;

                        case 'modal':
                            if (jQuery.inArray(mediaItem.vidid, window.modals) === -1) {
                                $('#modal-title').text(mediaItem.source);
                                $('#modal-time').text(mediaItem.start);

                                if (mediaItem.image != "") {
                                    $("#modal-image").attr("src", mediaItem.image);
                                    $("#modal-image").attr("alt", mediaItem.image_caption);
                                    if (mediaItem.image_caption != "") {
                                        $("#modal-image-caption").html(mediaItem.image_caption);
                                    }
                                }

                                $('#modal-fulltitle').text(mediaItem.title);
                                $('#modal-content').html(mediaItem.content);
                                $('#modalModal').modal({
                                    backdrop: false,
                                    show: true,
                                    showClose: false
                                })
                                window.modals.push(mediaItem.vidid);
                                $("#timekeeper").trigger('pause');
                            }
                            break;
                    };

                    if (mediaItem.media_type != 'modal') {
                        // Add video object and title we just created to DOM
                        $("#" + playerId + "_div").prependTo("#" + mediaItem.media_type + "s");
                    };

                    if (mediaItem.media_type == 'audio' || mediaItem.media_type == 'video') {
                        $("#" + playerId).prop("volume", $($("#" + playerId)).attr('media_volume'));
                        $("#" + playerId).prop("muted", $($("#" + playerId)).attr('muted'));

                        $("#" + playerId).currentTime = window.johng.timestamp() - hmsToSeconds(mediaItem.start) + mediaItem.jump;

                        // TODO: We're not doing anything with the promise right now, but will need to later
                        playPromise = $("#" + playerId).trigger('play').promise();
                    }

                    if (mediaItem.media_type == 'video') {

                        $("#" + playerId).on("ended", function () {
                            $("#" + playerId + "_div").empty().remove();
                        });

                        // When mousing over a player, unmute it so we can hear.
                        $($("#" + playerId + "_div")).mouseover(function () {
                            if ($('#' + playerId + '_div').hasClass("highlight") && (mediaItem.media_type == 'video')) {
                                $('#' + playerId).prop('muted', false);
                            }
                        });

                        // When mousing out of a player, mute it again,
                        // unless it is our main video, in which case don't mute.
                        $($("#" + playerId + "_div")).mouseout(function () {
                            if ($('#' + playerId + '_div').hasClass("highlight")) {
                                $('#' + playerId).prop('muted', false);
                            }
                        });

                        // When clicking a player, make it the main player,
                        $("#" + playerId + "_div").click(function () {
                            $('#' + mediaItem.media_type + 'playermain').children().prependTo('#' + mediaItem.media_type + 's');
                            $('#' + playerId).prop('muted', $('#' + playerId).attr('muted'));
                            if ($('#' + playerId + '_div').hasClass("highlight")) {
                                $('div').removeClass("highlight");
                            } else {
                                $('div').removeClass("highlight");
                                $('#' + mediaItem.media_type + 's').find(mediaItem.media_type).prop('muted', true);
                                $('#' + playerId + '_div').prependTo('#' + mediaItem.media_type + 'playermain')
                                    .addClass("highlight");
                                $('#' + playerId).prop('muted', false);
                            }
                            return false;
                        });
                    }
                }
            }
        )
    }

    const audioPlayers = Plyr.setup('.plyr-audio', { controls: ['current-time', 'duration', 'mute'] });
    const videoPlayers = Plyr.setup('.plyr-video', { controls: [''], clickToPlay: false });

}

// Every time the media player's time changes, this function weill be called
// This is our main running function
window.johng.tick(true, function (activeItems, timestamp) {
    var plusSixtySeconds = window.johng.data(timestamp + 60);
    plusSixtySeconds.forEach(function (item) {
        if (item.media_type == 'audio') { // just audio players for now
            preloadMediaFile(item.media_type, item.url, item.vidid);
        }
    });


    // Set some variables
    let currentItemsList = [], activeItemsList = [], currentItems = [];
    $('.timeText').text(getTimeText(window.timekeeper.currentTime));


    // We slice the currentItems list so we can an Array instead of an HTMLCollection
    currentItems = Array.prototype.slice.call(document.querySelectorAll("div.htmlitem, video:not(.handsoff), audio:not(.handsoff)"));

    // The activeItems is passed in to the function each time it is run
    activeItems.forEach(function (item) {
        activeItemsList.push(item.vidid);
    })


    // Current items are those currently on the page
    currentItems.forEach(function (item) {
        currentItemsList.push(item.id);
    })

    addItems(currentItemsList, activeItemsList);
    removeItems(currentItemsList, activeItemsList);

})

function create_audio(playerId, mediaItem) {
    var audioItem = {
        PlayerID: playerId,
        AudioURL: mediaItem.url,
        Volume: mediaItem.volume,
        Type: mediaItem.type,
        Title: mediaItem.source + ' - ' + mediaItem.title
    };

    var template = document.getElementById('audio_player_template').innerHTML;
    return $.parseHTML(
        $.trim (
            Mustache.render(
                template,
                audioItem
            )
        )
    );
}

function create_html(playerId, mediaItem) {
    var htmlItem = {
        ItemID: playerId,
        Time: formatTime(mediaItem.start_date),
        Title: mediaItem.title,
        ImageURL: mediaItem.image,
        Content: mediaItem.content
    };

    var template = document.getElementById('html_item_template').innerHTML;
    return $.parseHTML(
        $.trim (
            Mustache.render(
                template,
                htmlItem
            )
        )
    );
}

function create_video(playerId, mediaItem) {
    if (mediaItem.format == 'm3u8') {
        mediaType = "application/x-mpegURL"
    } else if (mediaItem.format == "mpd") {
        mediaType = "application/dash+xml"
    } else (
        mediaType = mediaItem.media_type + "/" + mediaItem.format
    );

     var videoItem = {
        PlayerID: playerId,
        VideoURL: mediaItem.url,
        Type: mediaItem.type,
        Source: mediaItem.source
    };

    var template = document.getElementById('video_item_template').innerHTML;
    return $.parseHTML(
        $.trim (
            Mustache.render(
                template,
                videoItem
            )
        )
    );

}