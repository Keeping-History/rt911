// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Easter Time, and runs to 11:59:59 PM the same day.
//

start = "08:49:35";
updateData();

// Setup things when the document is ready
$(document).ready(function () {

    $(".nav-link").click(function () {
        pauseAllPlayers();
        jumpIt(moment($(this).children().text(), ["h:mm A"]).format("HH:mm:ss"));
    });

    $("#playButton").on("click", function () {
        $("#timekeeper").trigger('play');
    });

    $("#pauseButton").on("click", function () {
        $("#timekeeper").trigger('pause');
    });

    $('.nav-link').on("click", function () {
        pauseAllPlayers();
        jumpIt(convert12Hto24H(this.text));
    })

    $('.ffrw').on("click", function () {
        moveTime($(this).data("skip"));
    });

    // If updating form fields, add their changes to the URL
    $("#filters input").on("click", updateData);
    $("select").on("change", updateData);

    // Add listeners so that when our main media player is moved others do the same
    addTimekeeperListeners();

    // Make sure the child players are always paused when the timeline player is also paused
    window.setInterval(function () {
        if (!isPlaying('timekeeper')) {
            pauseAllPlayers()
        };
    }, 1000);
    // Enable our tooltips for navigation items
    $('[data-toggle="tooltip"]').tooltip();

    // Turn on our AOL hold overlay and start the show
    //overlayOn();
    //$('#aol').trigger("play");

    // Once the AOL vid is done, let's close it.
    $('#aol').on("ended", function(){
        overlayOff();
    })

    // Once the pop-up is gone, remove the remove button.
    $('#closepopup').on('click', function(){
        overlayOff();
    })

    muteAudioPlayers();

    $('#mute_all_audio').click(function () {
        if ($(this).is(':checked')) {
            muteAudioPlayers();
        } else {
            //unmuteAudioPlayers();
        }
    });


});
