jQuery(function () {
    const interfaceAudioPlayer = new Audio();

    function playInterfaceSound(sound) {
        sounds = {
            "boot": "../rsrc/boot.mp3",
            "close": "../rsrc/close.mp3",
            "menu": "../rsrc/menu.mp3",
            "move_stop": "../rsrc/move_stop.mp3",
            "open": "../rsrc/open.mp3",
            "windowshade_collapse": "../rsrc/windowshade_collapse.mp3",
            "windowshade_expand": "../rsrc/windowshade_expand.mp3",
        };

        if (sound in sounds) {
            interfaceAudioPlayer.src = sounds[sound];
            interfaceAudioPlayer.play();
        }
    }

    // Helper function to decide if browser is mobile or not
    function isMobile() {
        try {
            document.createEvent("TouchEvent");
            return true;
        } catch (e) {
            return false;
        }
    }

    //Make windows movable and make sure the active window is on top
    jQuery(".draggable-window").draggable({
        handle: "h1.title",
        start: function () {
            jQuery(".content").css("z-index", "1100");
            jQuery(this).css("z-index", "1200");
        },
    });

    //Make windows resizable
    jQuery(".resizable").resizable({
        handles: "se",
        stop: function (event, ui) {
            playInterfaceSound("move_stop");
        },
    });

    // Zoom Box -- Make Window Full Screen and toggle back
    jQuery(".zoom-box").on("click", function () {
        b = this.closest(".content");
        isMax = jQuery(this).data("max");

        if (!isMax) {
            jQuery(b)
                .css("width", "99%")
                .css("height", "95%")
                .css("left", ".5rem")
                .css("top", "2.5rem");

            jQuery(this)
                .data("width", jQuery(b).css("width"))
                .data("height", jQuery(b).css("height"))
                .data("top", jQuery(b).css("top"))
                .data("left", jQuery(b).css("left"))
                .data("max", true);
            playInterfaceSound("windowshade_expand");
        } else {
            jQuery(b).removeAttr("style");
            playInterfaceSound("windowshade_collapse");

            jQuery(this).data("max", false);
        }
    });

    // Windowshade Box -- Minimize the window to just the title bar
    jQuery(".windowshade-box").on("click", function () {
        let contentBox = jQuery(this).closest(".content");
        contentBox.css("z-index", "1");
        let shadeHeight = jQuery(this).data(
            "shade-height",
            jQuery(this).css("height")
        );
        if (jQuery(this).hasClass("shade")) {
            jQuery(contentBox).children(".inner").removeClass("hidden");
            jQuery(contentBox)
                .children(".ui-resizable-handle")
                .removeClass("hidden");
            jQuery(contentBox).css("height", shadeHeight);
            jQuery(this).removeClass("shade");
            playInterfaceSound("windowshade_expand");
        } else {
            jQuery(contentBox).children(".inner").addClass("hidden");
            jQuery(contentBox)
                .children(".ui-resizable-handle")
                .addClass("hidden");
            jQuery(contentBox).css("height", "");
            jQuery(this).addClass("shade");
            playInterfaceSound("windowshade_collapse");
        }
    });

    // Close Box -- Close the window when clicked
    jQuery(".close-box, .close-button").on("click", function () {
        a = this.closest(".content");
        jQuery(a).addClass("hidden");
        playInterfaceSound("close");
    });

    // Enable Desktop Icons
    if (isMobile()) {
        jQuery(".icon").on("click", function () {
            jQuery("#" + jQuery(this).get(0).id.split("-")[1])
                .removeClass("hidden")
                .css("z-index", "9000");
            playInterfaceSound("open");
        });
    } else {
        jQuery(".draggable-icon").draggable({});
        jQuery(".icon").on("dblclick", function () {
            jQuery("#" + jQuery(this).get(0).id.split("-")[1])
                .removeClass("hidden")
                .css("z-index", "9000");
            playInterfaceSound("open");
        });
    }

    // Make sure the active window is on top
    jQuery(".content").on("click", function () {
        jQuery(".content").css("z-index", "1100");
        jQuery(this).css("z-index", "1200");
    });

    jQuery("#nav-list li").on("click touch", function () {
        jQuery(this).children().show();
    });

    jQuery("#nav-list li").on("mouseleave", function () {
        jQuery(this).children("ul").hide();
    });

    // Enable menu items to be clickable by default and open a windows/app with the same name
    jQuery("#nav-list li ul li").on("click", function () {
        playInterfaceSound("play");
        jQuery("#" + jQuery(this).get(0).id.split("-")[1])
            .removeClass("hidden")
            .css("z-index", "9000");
    });
});
