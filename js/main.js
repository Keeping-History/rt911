// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Easter Time, and runs to 11:59:59 PM the same day.
//

baseremoteurl = "https://civil-clarity-280121.ue.r.appspot.com/media/";
start = "08:49:35";
var data = getData();

window.data.forEach(function (item) {
    if (item.media_type == 'audio') {
        //preloadAudioFile(item.url);
    }
}
)

function addItems(currentItemsList, activeItemsList) {
    // Show which players are not active but should be added
    let addPlayers = activeItemsList.filter(x => !currentItemsList.includes(x));

    // And add them
    if (Array.isArray(addPlayers)) {
        // Ok, so addPlayers is an actual Array, so we can loop over it
        addPlayers.forEach(
            function (playerId) {
                // Does a player window with the same ID already exist?
                var doesPlayerExist = document.getElementById(playerId);

                if (!doesPlayerExist) {
                    // Grab the video data item because we need it
                    var mediaItem = data.find(data => data.vidid === playerId);

                    // If not, then let's create a container...
                    var newMediaItemContainer = $('<div/>')
                        .attr("id", playerId + '_div')

                        switch (mediaItem.media_type) {

                        case 'video':
                            var newMediaItem = $('<video />', {
                                'id': playerId,
                                'src': mediaItem.url,
                                'type': mediaItem.media_type + '/' + mediaItem.format,
                                'controls': false,
                                'muted': true,
                                'preload': 'auto',
                                'class': '',
                            });

                            var newMediaItemTitle = $('<h2 />')
                                .attr("id", playerId + '_title')
                                .text(mediaItem.source);

                            break;

                        case 'audio':
                            var newMediaItem = $('<audio />', {
                                'id': playerId,
                                'src': mediaItem.url,
                                'type': mediaItem.media_type + '/' + mediaItem.format,
                                'controls': true,
                                'autoplay': false,
                                'media_volume': mediaItem.volume,
                                'class': '',
                          });

                            var newMediaItemTitle = $('<h2 />')
                                .attr("id", playerId + '_title')
                                .text(mediaItem.source + ' - ' + mediaItem.title);

                            break;

                        case 'html':
                            var newMediaItem = $('<div />', {
                                'id': playerId
                            })
                                .addClass('embededHTML')
                                .html(mediaItem.content);
                                newMediaItem.prepend($('<img />',  {
                                    'src': mediaItem.image,
                                    'style': 'float: right; width: 35%'
                                }))
                            var newMediaItemTitle = $('<h6 />')
                                .text(formatTime(mediaItem.start_date) + ' - ' + mediaItem.title);

                            break;

                        default:
                            var newMediaItem = $('<div />', {
                                'id': playerId
                            })
                                .addClass('embededHTML')
                                .text(mediaItem.full_title)

                            var newMediaItemTitle = $()
                                .text(mediaItem.source);

                            break;
                    };



                    // Add video object and title we just created to DOM
                    newMediaItemTitle.appendTo($(newMediaItemContainer));
                    newMediaItem.appendTo($(newMediaItemContainer));
                    newMediaItemContainer.prependTo("#" + mediaItem.media_type + "s");
                    newMediaItem[0].currentTime = johng.timestamp() - hmsToSeconds(mediaItem.start) + mediaItem.jump;
                    newMediaItem.prop("volume", $(newMediaItem).attr('media_volume'));
                    newMediaItem.prop("muted", $(newMediaItem).attr('muted'));

                    if (mediaItem.media_type == 'html') {
                        newMediaItem.readmore({
                            collapsedHeight: 0,
                            speed: 75,
                            lessLink: '<button class="btn mr-2 mb-2 btn-primary" type="button"><span class="btn-text"><a href="#">Read Less</a></span></button>',
                            moreLink: '<button class="btn mr-2 mb-2 btn-primary" type="button"><span class="btn-text"><a href="#">Read More</a></span></button>',
                            blockCSS: 'display: block; float: right;'
                        })
                    }

                    // TODO: We're not doing anything with the promise right now, but will need to later
                    playPromise = newMediaItem.trigger('play').promise();

                    // When mousing over a player, unmute it so we can hear.
                    $(newMediaItemContainer).mouseover(function () {
                        if ($('#' + playerId + '_div').hasClass("highlight") && (mediaItem.media_type == 'video')) {
                            $('#' + playerId).prop('muted', false);
                        }
                    });

                    // When mousing out of a player, mute it again,
                    // unless it is our main video, in which case don't mute.
                    $(newMediaItemContainer).mouseout(function () {
                        if ($('#' + playerId + '_div').hasClass("highlight") && (mediaItem.media_type == 'video')) {
                            $('#' + playerId).prop('muted', false);
                        }
                    });

                    // When clicking a player, make it the main video player,
                    $(newMediaItemContainer).click(function () {
                        if ((mediaItem.media_type == 'video')) {
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
                            }}
                        return false;
                    });

                }
            }
        )
    }
}

// Boilerplate code to load our framework, memento.js
var johng = memento();

// Attach our memento object to our timekeeper audio player
johng.node(timekeeper);

// This function loads the data into johng
johng.all_data(window.data);

// Initialize the tracker
johng();

// Every time the media player's time changes, this function weill be called
// This is our main running function
johng.tick(true, function (activeItems, timestamp) {

    // Set some variables
    let currentItemsList = [], activeItemsList = [], currentItems = [];
    $('.timeText').text(getCurrentTime());
    // We slice the currentItems list so we can an Array instead of an HTMLCollection
    currentItems = Array.prototype.slice.call(document.querySelectorAll("div.embededHTML, video:not(.handsoff), audio:not(.handsoff)"));

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

});

function overlayOn() {
    document.getElementById("overlay").style.display = "block";
}

function overlayOff() {
    document.getElementById("overlay").style.display = "none";
    document.getElementById("closepopupbutton").style.display = "none";
}
// Setup things when the document is ready
$(document).ready(function () {
    // If updating form fields, add their changes to the URL
    $("input[type='checkbox'], input[type='radio']").on("click", updateData);
    $("select").on("change", updateData);

    addTimelineListeners();
    window.setInterval(function () {
        if (!isPlaying('timekeeper')) {
            pauseAllPlayers()
        };
    }, 1000);
    $(function () {
        $('[data-toggle="tooltip"]').tooltip()
    })
    //overlayOn();
    //$('#aol').trigger("play");
    $('#aol').on("ended", function(){
        overlayOff();
    })

    $('#closepopup').on('click', function(){
        overlayOff();
        this.display('none');
    })

});
