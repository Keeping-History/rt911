// Global Vars
var baseRemoteURL = "https://api.911realtime.org/";
var timeZone = {plus:6,pretty:"ET"} 
var globalModals = [];
var getNetworkCache = []
var getDataCache = []
var johng = memento();
var timeDrift = 5
var playoverDrift = 15
var playerSync = 2

// Media Contol and associated functios

// Caching and preload Functions
function preloadPlayers(data) {
    if (data != undefined || data.length > 0) {
        data.forEach(function (item) {
                preloadMediaFile(item.media_type, item.url, item.vidid);
        });
    }
}

function preloadMediaFile(mediaType, url, id) {
    if (!jQuery("#" + id + "_preload").length) {
        a = jQuery('<' + mediaType + ' />')
            .attr('src', url)
            .attr('id', id + '_preload')
            .attr('preload', true)
            .attr('autoplay', false)
            .attr('muted', true)
            .css('display', 'none')
            .addClass('handsoff')
            .appendTo('#preloads');
    }
}

// Audio Control
function muteAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        jQuery(this).prop('muted', true);
    });
}

function unmuteAudioPlayers() {
    jQuery("audio:not(.handsoff)").prop('muted', false);
}

function muteAudioPlayers() {
    jQuery("audio:not(.handsoff)").prop('muted', true);
}

// Playback Control
function pauseAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        jQuery(this).get(0).pause();
    });
}

function playAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        jQuery(this).get(0).play();
    });
}

function setTimeAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        if(Math.abs(getPlayerTime(this.id) - jQuery(this).get(0).currentTime) > timeDrift) {
            jQuery(this).get(0).fastSeek(getPlayerTime(this.id));
        }
    });
}

function setTimePlayer(playerId) {
    video = jQuery("#" + playerId).get(0)
    video.fastSeek(getPlayerTime(playerId));
}


// Time Functions
function getPlayerTime(playerId) {
    jsonData = getData();
    dataItem = jsonData.find(jsonData => jsonData.vidid === playerId);
    return window.johng.timestamp() - dataItem.start + dataItem.jump;
}

//Get the Current time in text format
function secondsToTimeFormatted(seconds) {
    var d = new Date(0);
    d.setSeconds(seconds);
    d.setHours(d.getHours() + window.timeZone.plus); // Eastern Time Zone adjustment
    return dateFormatter(d) + " " + window.timeZone.pretty;
}

function dateFormatter(d) {
    var hours = d.getHours();
    var minutes = d.getMinutes();
    var seconds = d.getSeconds();
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0' + minutes : minutes;
    seconds = seconds < 10 ? '0' + seconds : seconds;

    return hours + ':' + minutes + ":" + seconds + " " + ampm;

}

// Adds the base API URL and any URL filters and returns a full URL for AJAX calls
function getURL() {
    var d = new Date();
    return window.baseRemoteURL + "?tm=" + d.getTime() + "&" + jQuery("#filters :input[value!='all']").serialize();
}

// Grabs the json via ajax
function getData() {
    
    if (window.getDataCache.length > 0) {
        return window.getDataCache;
    } else {
        $.ajax({
            type: 'GET',
            url: getURL(),
            dataType: 'json',
            async: false,
            cache: true,
            success: function (data) {
                window.getDataCache = data;
        }});
        return window.getDataCache;
    }
}

// Grabs the json via ajax
function getNetworks() {
    if (typeof window.getNetworkCache !== 'undefined') {
        return window.getNetworkCache;
    } else {
        $.ajax({
            type: 'GET',
            url: window.baseRemoteURL + 'networks',
            dataType: 'json',
            async: false,
            cache: true,
            success: function (data) {
                window.getNetworkCache = data;
        }});
        return window.getNetworkCache;
    }
}


function hmsToSeconds(hmsString) {
    var a = hmsString.split(':'); // split it at the colons

    // minutes are worth 60 seconds. Hours are worth 60 minutes.
    var seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);

    return seconds;
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
                    var mediaItem = getData().find(data => data.vidid === playerId);
                    if(mediaItem.format == 'audio' || mediaItem.format == 'video') {
                        setTimeout(function(){ 
                            jQuery('#' + playerId + '_div').remove();
                            jQuery('#' + playerId + '_preload').remove();
                        }, playoverDrift * 1000);
                    } else {
                        jQuery('#' + playerId + '_div').remove();
                    }
                }
            });
    }
}

function updateData() {
    updateNetworks();
    data = getData();
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
                    var mediaItem = getData().find(data => data.vidid === playerId);

                    switch (mediaItem.media_type) {
                        case 'video':
                            jQuery("#videos").append(create_video(playerId, mediaItem));
                            break;

                        case 'audio':
                            jQuery("#audios").append(create_audio(playerId, mediaItem));
                            break;

                        case 'html':
                            jQuery("#htmls").append(create_html(playerId, mediaItem));
                            // TODO: This has some wonky UI right now
                            // setReadMore(playerId);
                            break;

                        case 'modal':
                            if (jQuery.inArray(mediaItem.vidid, window.globalModals) === -1) {
                                jQuery('#modal-title').text(mediaItem.source);
                                jQuery('#modal-time').text(mediaItem.start);

                                if (mediaItem.image != "") {
                                    jQuery("#modal-image").attr("src", mediaItem.image);
                                    jQuery("#modal-image").attr("alt", mediaItem.image_caption);
                                    if (mediaItem.image_caption != "") {
                                        jQuery("#modal-image-caption").html(mediaItem.image_caption);
                                    }
                                }

                                jQuery('#modal-fulltitle').text(mediaItem.title);
                                jQuery('#modal-content').html(mediaItem.content);
                                jQuery('#modalModal').modal({
                                    backdrop: false,
                                    show: true,
                                    showClose: false,
                                    closeExisting: false,
                                    fadeDuration: 100
                                })
                                window.globalModals.push(mediaItem.vidid);
                                jQuery("#timekeeper").trigger('pause');
                            }
                            break;
                    };

                    if (mediaItem.media_type != 'modal') {
                        // Add video object and title we just created to DOM
                        jQuery("#" + playerId + "_div").prependTo("#" + mediaItem.media_type + "s");
                    };

                    if (mediaItem.media_type == 'audio') {
                        Plyr.setup("#" + playerId, { controls: ['current-time', 'duration', 'mute'] });
                    };

                    if (mediaItem.media_type == 'audio' || mediaItem.media_type == 'video') {
                        jQuery("#" + playerId).prop("volume", jQuery(jQuery("#" + playerId)).attr('media_volume'));
                        jQuery("#" + playerId).prop("muted", jQuery(jQuery("#" + playerId)).attr('muted'));
                        jQuery("#" + playerId).currentTime = window.johng.timestamp() - mediaItem.start + mediaItem.jump;

                        // TODO: We're not doing anything with the promise right now, but will need to later
                        promise = jQuery("#" + playerId).trigger('play');
                        jQuery("#" + playerId).bind("ended", function() {
                            jQuery("#" + $(this).attr('id') + "_div").empty().remove();
                            jQuery("#" + $(this).attr('id') + "_preload").empty().remove();
                        });
                    }

                    if (mediaItem.media_type == 'video') {
                        Plyr.setup("#" + playerId, { controls: ['current-time', 'progress', 'airplay', 'fullscreen'], clickToPlay: false });

                        // When mousing over a player, unmute it so we can hear.
                        jQuery(jQuery("#" + playerId + "_div")).mouseover(function () {
                            if (jQuery('#' + playerId + '_div').hasClass("highlight") && (mediaItem.media_type == 'video')) {
                                jQuery('#' + playerId).prop('muted', false);
                            }
                        });

                        if (mediaItem.format == 'm3u8') {
                            if (Hls.isSupported()) {
                                var video = document.getElementById(playerId);
                                var hls = new Hls();
                                // bind them together
                                hls.attachMedia(video);
                                hls.on(Hls.Events.MEDIA_ATTACHED, function () {
                                    hls.loadSource(mediaItem.url);
                                });
                            }
                        }
                        // When mousing out of a player, mute it again,
                        // unless it is our main video, in which case don't mute.
                        jQuery(jQuery("#" + playerId + "_div")).mouseout(function () {
                            if (jQuery('#' + playerId + '_div').hasClass("highlight")) {
                                jQuery('#' + playerId).prop('muted', false);
                            }
                        });

                        jQuery("#" + playerId).get(0).onloadeddata = (event) => {
                            console.log('loaded data for ' + playerId)
                        };

                        // When clicking a player, make it the main player,
                        jQuery("#" + playerId + "_div").click(function () {
                            jQuery('#' + mediaItem.media_type + 'playermain').children().prependTo('#' + mediaItem.media_type + 's');
                            jQuery('#' + playerId).prop('muted', jQuery('#' + playerId).attr('muted'));
                            if (jQuery('#' + playerId + '_div').hasClass("highlight")) {
                                jQuery('div').removeClass("highlight");
                                jQuery('#' + playerId).prop('muted', true);
                            } else {
                                jQuery('div').removeClass("highlight");
                                jQuery('#' + mediaItem.media_type + 's').find(mediaItem.media_type).prop('muted', true);
                                jQuery('#' + playerId + '_div').prependTo('#' + mediaItem.media_type + 'playermain')
                                    .addClass("highlight");
                                jQuery('#' + playerId).prop('muted', false);
                            }
                            return false;
                        });
                    }
                }
            });
    }
}

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
        $.trim(
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
        Time: dateFormatter(Date.parse(mediaItem.start_date)),
        Title: mediaItem.title,
        ImageURL: mediaItem.image,
        Content: mediaItem.content
    };

    var template = document.getElementById('html_item_template').innerHTML;
    return $.parseHTML(
        $.trim(
            Mustache.render(
                template,
                htmlItem
            )
        )
    );
}

function create_video(playerId, mediaItem) {
    if (mediaItem.format == 'm3u8') {
        mediaType = "application/x-mpegURL";

    } else if (mediaItem.format == "mpd") {
        mediaType = "application/dash+xml";
    } else (
        mediaType = mediaItem.media_type + "/" + mediaItem.format
    );

    var videoItem = {
        PlayerID: playerId,
        VideoURL: mediaItem.url,
        Type: mediaItem.type,
        Source: mediaItem.source,
        StartTime: mediaItem.startTime

    };

    var template = document.getElementById('video_item_template').innerHTML;
    return $.parseHTML(
        $.trim(
            Mustache.render(
                template,
                videoItem
            )
        )
    );

}

function isMediaReady() {
    current_data = window.johng.data();
    current_data.forEach(element => {
        if (element.media_type == 'video') {
            jQuery("#" + element.vidid).on('canplay', function () {
                console.log('canplay: ', element);
            });
        }
    });
}

function isPlaying(playerId) {
    var player = document.getElementById(playerId);
    return !player.paused && !player.ended && 0 < player.currentTime;
}

function moveTime(increment) {
    jQuery('#timekeeper').get(0).fastSeek(jQuery('#timekeeper').get(0).currentTime + increment);
    setTimeAllPlayers();
}

function setReadMore(playerId) {
    jQuery("#" + playerId).readmore({
        embedCSS: false,
        collapsedHeight: 0,
        speed: 75,
        lessLink: '<button class="command_button" type="button"><span class="btn-text"><a href="#">Read Less</a></span></button>',
        moreLink: '<button class="command_button" type="button"><span class="btn-text"><a href="#">Read More</a></span></button>',
        blockCSS: 'display: inline-block; float: right;'
    });
}
// Jump to the right timestamp
function jumpToTime(stringTimeInput) {

    stringTime = $.trim(stringTimeInput);
    const [time, modifier] = stringTime.split(' ');
    let [hours, minutes, seconds] = time.split(':');
    if (seconds === undefined) {
        seconds = "00";
    }

    if (hours === '12') {
        hours = '00';
    }

    if (modifier.toUpperCase() === 'PM') {
        hours = parseInt(hours, 10) + 12;
    }

    jQuery('#timekeeper').get(0).currentTime = hmsToSeconds(`${hours}:${minutes}:${seconds}`);

    setTimeAllPlayers();
}

function addTimekeeperListeners() {
    // Events for the main timeline controller
    // When the timeline controller is told to play, make sure the child video players are running
    //jQuery('#timekeeper').get(0).addEventListener('play', playAllPlayers, false);

    // When the timeline controller is paused, make sure the child video players also pause
    jQuery('#timekeeper').get(0).addEventListener('pause', setTimeAllPlayers, false);

     // When the timeline is seeked, then update the play location of the child video players
    jQuery('#timekeeper').get(0).addEventListener('seeked', setTimeAllPlayers, false);
}

function updateNetworks() {
    networks = getNetworks();
    networks.forEach(function (item) {
        jQuery('#network').append(jQuery('<option>').text(item).attr('value', item));
    });
}

// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Eastern Time, and runs to 11:59:59 PM the same day.
//

// Setup things when the document is ready
jQuery(function () {
    jQuery('#timekeeper').get(0).setAttribute("autoplay", "false");

    jQuery('.close-modal-boot-button').click(function (event) {
        event.preventDefault();
        addTimekeeperListeners();
        jQuery("#chime").trigger('play');
        jQuery("#bootScreen").fadeOut(1000);
        jumpToTime("08:35:00 AM");
        muteAudioPlayers();
        setTimeAllPlayers();
        
        $.modal.close();
    });

    jQuery(".close-modal-button").click(function () {
        event.preventDefault();
        $.modal.close();
        jQuery("#timekeeper").trigger('play');
    });

    jQuery("#playButton").on("click", function () {
        jQuery("#timekeeper").trigger('play');
    });

    jQuery("#syncButton").on("click", function () {
        setTimeAllPlayers();
    });

    jQuery("#loadButton").on("click", function () {
        setTimeAllPlayers();
    });


    jQuery("#pauseButton").on("click", function () {
        jQuery("#timekeeper").trigger('pause');
    });

    jQuery('.time-marker').on("click", function () {
        jumpToTime(this.text);
    });

    jQuery('.ffrw').on("click", function () {
        moveTime(parseInt(jQuery(this).data("skip")));
    });

    jQuery('#mute_all_audio').click(function () {
        if (jQuery(this).is(':checked')) {
            muteAudioPlayers();
            jQuery('#radio_mute_icon').attr('src', 'img/sound_off.png');
        } else {
            //unmuteAudioPlayers();
            jQuery('#radio_mute_icon').attr('src', 'img/sound_on.png');
        }
    });

    // If updating form fields, add their changes to the URL
    jQuery("#filters input").on("click", updateData);
    jQuery("select").on("change", updateData);

    // Make sure the child players are always paused when the timeline player is also paused
    window.setInterval(function () {
        if (!isPlaying('timekeeper')) {
            pauseAllPlayers();
        }
    }, playerSync * 1000);

    window.setInterval(function () {
        if (isPlaying('timekeeper')) {
            playAllPlayers();
        }
    }, playerSync * 1000);

    jQuery("#menu-play").click(function () {
        jQuery("#timekeeper").trigger('play');
    });

    jQuery("#menu-pause").click(function () {
        jQuery("#timekeeper").trigger('pause');
    });

    jQuery("#jumpItButton").click(function () {
        jumpHour = jQuery("#jumpItHour").val();
        jumpMinute = jQuery("#jumpItMinute").val();
        jumpSecond = jQuery("#jumpItSecond").val();
        jumpPeriod = jQuery("#jumpItPeriod").val();

         if (jumpHour == "") {
            jumpHour = "00";
        }
        if (jumpMinute == "") {
            jumpMinute = "00";
        }
        if (jumpSecond == "") {
            jumpSecond = "00";
        }

        jQuery("#jumpItHour").val(jumpHour);
        jQuery("#jumpItMinute").val(jumpMinute);
        jQuery("#jumpItSecond").val(jumpSecond);
        jQuery("#jumpItPeriod").val(jumpPeriod);

        jumpToTime(jumpHour + ":" + jumpMinute + ":" + jumpSecond + " " + jumpPeriod);
    });

    // bind audio to memento object
    window.johng.node(jQuery("#timekeeper").get(0));

    // This function loads the data into johng
    window.johng.all_data(getData());

    // Every time the media player's time changes, this function weill be called
    // This is our main running function
    window.johng.tick(true, function (activeItems, timestamp, node) {
        var plusSixtySeconds = window.johng.data(timestamp + 60);
        if (Array.isArray(plusSixtySeconds)) {
            plusSixtySeconds.forEach(function (item) {
                if (item.media_type == 'audio') { // just audio players for now
                    preloadMediaFile(item.media_type, item.url, item.vidid);
                }
            });
        }

        // Set some variables
        var current_data = window.johng.data();

        let currentItemsList = [], activeItemsList = [], currentItems = [];

        // We slice the currentItems list so we can an Array instead of an HTMLCollection
        currentItems = Array.prototype.slice.call(document.querySelectorAll("div.htmlitem, video:not(.handsoff), audio:not(.handsoff)"));

        // The activeItems is passed in to the function each time it is run
        if (Array.isArray(activeItems)) {
            activeItems.forEach(function (item) {
                activeItemsList.push(item.vidid);
            });
        }

        // Current items are those currently on the page
        if (Array.isArray(currentItems)) {
            currentItems.forEach(function (item) {
                currentItemsList.push(item.id);
            });
        }

        addItems(currentItemsList, activeItemsList);
        removeItems(currentItemsList, activeItemsList);

        // Set the "clock" onscreen to the curent time
        jQuery('.timeText').text(secondsToTimeFormatted(jQuery('#timekeeper').get(0).currentTime));

        jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
            if(jQuery(this).get(0).readyState < 2)
                console.log(jQuery(this).get(0).id, jQuery(this).get(0).readyState);
            });

    });

    // Initialize the tracker
    window.johng();

});