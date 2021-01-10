$(function () {
    //Make windows movable and make sure the active window is on top
    $(".draggable-window").draggable({
        handle: "h1.title",
        start: function () {
            $(".content").css("z-index", "1100");
            $(this).css("z-index", "1200");
        },
    });

    //Make icons movable
    $(".draggable-icon").draggable();

    //Make windows resizable
    //TODO: This is not currently working because we don't have a grab button
    $(".resizable").resizable();

    //Enable Icons and Menu items to be clickable and open their windows/apps
    $(".icon").dblclick(function () {
        $("#" + $(this).get(0).id.split("-")[1]).removeClass('hidden').css("z-index", "9000");
    })

    // Zoom Box -- Make Window Full Screen and toggle back
    $(".zoom-box").on("click", function () {
        b = this.closest(".content");
        isMax = $(this).data("max");

        if (!isMax) {
            $(b)
                .css("width", "99%")
                .css("height", "95%")
                .css("left", ".5rem")
                .css("top", "2.5rem");

            $(this)
                .data("width", $(b).css("width"))
                .data("height", $(b).css("height"))
                .data("top", $(b).css("top"))
                .data("left", $(b).css("left"))
                .data("max", true);

        } else {
            $(b)
                .css("width", $(this).data("width"))
                .css("height", $(this).data("height"))
                .css("top", $(this).data("top"))
                .css("left", $(this).data("left"))
                .css("z-index","900")

            $(this)
                .data("max", false);

        }
    });

    // Windowshade Box -- Minimize the window to just the title bar
    $(".windowshade-box").on("click", function () {
        c = this.closest(".content");
        c.css("z-index", "1");
        d = $(this).data("shade");
        e = $(this).data("shade-height", $(this).css("height"));

        if (!d) {
            $(c).children('.inner').addClass('hidden');
            $(c).css('height', "");
            $(this).data("shade", true);

        } else {
            $(c).children('.inner').removeClass('hidden');
            $(c).css("height", e);
            $(this).data("shade", false);
        }

    });
    
    // Close Box -- Close the window when clicked
    $(".close-box, .close-button").on("click", function () {
        a = this.closest(".content");
        $(a).addClass('hidden');
    });

    // Make sure the active window is on top
    $(".content").click(function () {
        $(".content").css("z-index", "1100")
        $(this).css("z-index", "1200");
    });

    $("#menu-tv").click(function () {
        $("#tv").removeClass('hidden').css("z-index", "9000");;
    });

    $("#menu-news").click(function () {
        $("#news").removeClass('hidden').css("z-index", "9000");;
        setReadMores();
    });

    $("#menu-audio").click(function () {
        $("#audio").removeClass('hidden').css("z-index", "9000");;
    });

    $("#menu-about").click(function () {
        $("#about").removeClass('hidden').css("z-index", "9000");
    });

    $("#menu-play").click(function () {
        $("#timekeeper").trigger('play');
    });

    $("#menu-pause").click(function () {
        $("#timekeeper").trigger('pause');
    });

    $("#menu-settings").click(function () {
        $("#settings").removeClass('hidden');
    });

});
