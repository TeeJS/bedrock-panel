//-[Imports]------------------------------------------
import { Vector2D } from "./Lib/Math/Vector2D.js";
import Sprite from "./Lib/Image/SpriteSheet.js";
import { $ } from "./utils.js";
import Grass from "./Game/Objects/Grass.js";
import Cannon from "./Game/Objects/Cannon.js";
import { KEYS, handleKeyboardCallbacks, registerKeyEventCallback } from "./Game/KeyboardController.js";
import Kitten from "./Game/Objects/Kitten.js";
import ObjectGenerator from "./Game/Objects/ObjectGenerator.js";
import ScoreBoard from "./Game/Objects/ScoreBoard.js";
import * as TouchController from "./Game/TouchController.js";
import RoundButton from "./Game/UI/RoundButton.js";
import HeightDisplay from "./Game/Objects/HeightDisplay.js";
import MenuScreen from "./Game/UI/Screens/MenuScreen.js";
import HowToPlayScreen from "./Game/UI/Screens/HowToPlayScreen.js";
import { linearMap, randomInt } from "./Lib/Math/functions.js";
import Creditscreen from "./Game/UI/Screens/CreditsScreen.js";
import Timer from "./Game/Timer.js";
import SoundManager from "./Game/SoundManager.js";
import Renderer from "./Lib/Renderer/Renderer.js";
import Camera2D from "./Lib/Camera2D/Camera2D.js";
import DistanceDisplay from "./Game/Objects/DistanceDisplay.js";
//-[/Imports]------------------------------------------

// App options arrive from Bedrock Panel in the query string (served drop-in app);
// a #hash works too so the page can be opened directly during development.
const APP_PARAMS = new URLSearchParams(location.search || location.hash.replace(/^#/, "?"));
const EMBEDDED_IN_HOST = APP_PARAMS.has("_dark"); // Bedrock Panel always appends theme params
// Shared-score-server conventions (server/HANDOFF.md in kitten-cannon-remake):
// game slug on every call; arcade initials — the server keeps the first 3
// letters (A-Z only), so normalize the same way here.
const GAME_SLUG = "kitten-cannon";
window.userId = (APP_PARAMS.get("playerName") || "").trim().toUpperCase()
    .replace(/[^A-Z]/g, "").slice(0, 3) || null;
// Base URL of the score server ("Server URL (advanced)" app option). Blank = offline:
// high scores are kept in localStorage on this PC instead.
const SCORE_SERVER = (APP_PARAMS.get("serverUrl") || "").trim().replace(/\/+$/, "");
window.distance_travelled_px = 0;

function serverApi(path) {
    return SCORE_SERVER ? SCORE_SERVER + "/" + path : null;
}
// Kitten.js owns the per-run server save and can't import from here (circular),
// so it reaches these through window like it already does for userId.
window.KC_SERVER_API = serverApi;
window.KC_SAVE_LOCAL = (score) => saveLocalScore(score);
// Refresh the leaderboard once the run's score has landed, so the player's
// fresh entry shows on the board they're about to look at.
window.KC_ON_SCORE_SAVED = () => fetchLeaderboard();

// Offline score store: { "<player name>": bestScoreFeet, ... }
const LOCAL_SCORES_KEY = "kitten-cannon-scores";
function localScores() {
    try { return JSON.parse(localStorage.getItem(LOCAL_SCORES_KEY)) || {}; }
    catch (e) { return {}; }
}
function localPersonalBest() {
    return Math.floor(localScores()[window.userId] || 0);
}
function localGlobalBest() {
    return Math.floor(Math.max(0, ...Object.values(localScores())));
}
function saveLocalScore(scoreFeet) {
    const scores = localScores();
    const name = window.userId || "Player";
    if (scoreFeet > (scores[name] || 0)) {
        scores[name] = Math.floor(scoreFeet);
        try { localStorage.setItem(LOCAL_SCORES_KEY, JSON.stringify(scores)); } catch (e) { }
    }
}

async function main() {
    setup();
    canvas.style.display = "none";
    await preload();
    canvas.style.display = "block";
    gameLoop();
}
window.onload = main;


// disables console.log
console.log = () => { }


//-[Global Variables]------------------------------------------
// Most Important

let canvas, ctx;


// initialized in preload()
let sound_manager;
let screens_sprite;
let game_sprite;
let score_board;
let menu_screen;
let how_to_play_screen;
let credits_screen;

// general purpose (ownership unknown)
let highest_distance_travelled_px = 0;
let distance_travelled_px = 0;
let should_reset = false;
let max_skip_frames = 0;
let skip_frames = 0;
let globalHighScore = "0"; // Default global high score until fetched from server

let preload_message = "";
let preload_percentage = 0;

//// let bg = new Image();
//// bg.src = "ref_images/menu_screen.png";


// Constants
const GAME_SCREENS_E = {
    "Preload": 0b1,
    "Splash": 0b1 << 1,
    "Menu": 0b1 << 2,
    "Play": 0b1 << 3,
    "Help": 0b1 << 4,
    "Credits": 0b1 << 5,
};
const pixel_per_feet = 100;
const OBJECT_GAP = 800;
const TIME_SCALE = 60;

let CURRENT_GAME_SCREEN = GAME_SCREENS_E.Preload;

let timer;
let camera;
let renderer;

// in reset_game()
// Objects
let grass;
let cannon;
let kitty;
let objectGenerator;
//UIS
let fire_button;
let up_button;
let down_button;
let mute_button;
let height_display;
let distance_display;

let highScoreFetched = false; // Add this flag at the top with other global variables

// Keep track of ongoing requests and last fetch time
let fetchingHighScore = false;
let lastFetchTime = 0;
const MIN_FETCH_INTERVAL = 2000; // minimum 2 seconds between fetches

// Add this variable to preserve the personal high score
let personalBestDisplay = "0";

//-[/Global Variables]------------------------------------------ 


function setup() {
    canvas = $("cnvs");
    // Fill the whole display: fixed 640px world height, width matched to the
    // screen's aspect ratio (4:1 on the DK-QUAKE panel -> 2560x640), clamped to
    // the original 1040 minimum so narrow browser windows still work.
    const aspect = innerWidth / Math.max(1, innerHeight);
    canvas.height = 640;
    canvas.width = Math.round(Math.min(2560, Math.max(1040, 640 * aspect)));
    ctx = canvas.getContext("2d");
    resize();
}


async function preload() {
    sound_manager = new SoundManager();
    let proms = [];
    proms.push(new Promise(async (resolve, reject) => {
        game_sprite = await new Sprite("assets/sprite_sheet/kitty_cannon_dat").load();
        resolve();
    }));

    proms.push(new Promise(async (resolve, reject) => {
        screens_sprite = await new Sprite("assets/sprite_sheet/game_screens_dat").load();
        resolve();
    }));

    await Promise.all(proms);
    
    // Create scoreboard FIRST
    score_board = new ScoreBoard(ctx);
    
    // Load both global high score and personal best in parallel
    await Promise.all([
        fetchGlobalHighScore(),
        fetchPersonalHighScore()
    ]);

    menu_screen = new MenuScreen(ctx, screens_sprite, "Nicotine");
    how_to_play_screen = new HowToPlayScreen(ctx, screens_sprite, "Nicotine");
    credits_screen = new Creditscreen(ctx, screens_sprite, "Nicotine");

    // (An old `highest_distance_travelled_px = 0` here wiped the personal best
    // that fetchPersonalHighScore just loaded, so "Your Best" showed only the
    // current session. The fetched value must survive preload.)

    // Mute toggle, shown on every screen (top-right corner).
    mute_button = new RoundButton(ctx, sound_manager.muted ? "\u{1F507}" : "\u{1F50A}",
        new Vector2D(canvas.width - 50, 52), 40, "white", "rgba(0,0,0,0.45)");
    mute_button.font_size = 34;
    mute_button.onClick = () => {
        sound_manager.toggleMuted();
        mute_button.char = sound_manager.muted ? "\u{1F507}" : "\u{1F50A}";
    };

    reset_game();

    set_events();
    add_sounds();
}


function reset_game() {
    timer = new Timer();
    camera = new Camera2D(canvas.width, canvas.height);
    renderer = new Renderer(ctx, camera);

    should_reset = false;
    score_board.visible = false;
    grass = new Grass(renderer, game_sprite);
    cannon = new Cannon(renderer, game_sprite, sound_manager);
    kitty = new Kitten(renderer, game_sprite, sound_manager);
    objectGenerator = new ObjectGenerator(renderer, game_sprite, kitty, OBJECT_GAP, sound_manager);
    height_display = new HeightDisplay(renderer, pixel_per_feet, "Nicotine");
    distance_display = new DistanceDisplay(renderer, pixel_per_feet, "Nicotine"); // Initialize the distance display

    // Touch controls, clustered at the right edge for thumb reach: hold arrows to
    // sweep the barrel, tap FIRE to launch. Aiming never fires; only FIRE (or Space) does.
    up_button = new RoundButton(ctx, "▲", new Vector2D(canvas.width - 190, 390), 55, "white", "rgba(0,0,0,0.55)");
    down_button = new RoundButton(ctx, "▼", new Vector2D(canvas.width - 190, 530), 55, "white", "rgba(0,0,0,0.55)");
    fire_button = new RoundButton(ctx, "FIRE", new Vector2D(canvas.width - 72, 460), 65, "white", "#c62828", "Nicotine");
    fire_button.font_size = 44;

    camera.follow(new Vector2D(canvas.width / 2, canvas.height / 2), 1);

    // score reset
    distance_travelled_px = 0;
    add_button_events();
    timer.getTickS();
    
    // Fetch updated high scores at the start of each game
    fetchGlobalHighScore(0);
    
    highScoreFetched = false; // Reset the flag when starting a new game
}


function add_button_events() {

    fire_button.onClick = (function () {
        throw_kitty();
    });



    // score board
    score_board.onContinue = (async function () {
        should_reset = true;
    });
    score_board.onMenu = (async function () {
        CURRENT_GAME_SCREEN = GAME_SCREENS_E.Menu;
        max_skip_frames = skip_frames = 60;
    });


    menu_screen.onStartClick = function () {
        CURRENT_GAME_SCREEN = GAME_SCREENS_E.Play;
        max_skip_frames = skip_frames = 60;
    }
    menu_screen.onHelpClick = function () {
        CURRENT_GAME_SCREEN = GAME_SCREENS_E.Help;
        max_skip_frames = skip_frames = 60;
    }

    menu_screen.onCreditsClick = function () {
        CURRENT_GAME_SCREEN = GAME_SCREENS_E.Credits;
        max_skip_frames = skip_frames = 60;
    }

    how_to_play_screen.onBackClick = function () {
        CURRENT_GAME_SCREEN = GAME_SCREENS_E.Menu;
        max_skip_frames = skip_frames = 60;
    }

    credits_screen.onBackClick = function () {
        CURRENT_GAME_SCREEN = GAME_SCREENS_E.Menu;
        max_skip_frames = skip_frames = 60;
    }

}

function set_events() {
    registerKeyEventCallback(KEYS.w, () => {
        cannon.barrelUp();
    });
    registerKeyEventCallback(KEYS.arrowup, () => {
        cannon.barrelUp();
    });
    registerKeyEventCallback(KEYS.s, () => {
        cannon.barrelDown();
    });
    registerKeyEventCallback(KEYS.arrowdown, () => {
        cannon.barrelDown();
    });
    registerKeyEventCallback(KEYS.space, () => {
        throw_kitty();
    });
}


function add_sounds() {
    sound_manager.onLoad = (sound_name, progress_percentage) => {
        preload_message = "loaded sound " + sound_name;
        preload_percentage = progress_percentage;
    }

    sound_manager
        // .addSound("", "assets/audio_fx/1_whooshrev.m4a", 1.0)
        .addSound("after_load", "assets/audio_fx/2.m4a", 1.0)

        .addSound("hit1", "assets/audio_fx/5_hit1.m4a", 1.0)
        .addSound("hit2", "assets/audio_fx/4_hit2.m4a", 1.0)
        .addSound("hit3", "assets/audio_fx/3_hit3.m4a", 1.0)
        .addSound("hit4", "assets/audio_fx/2_hit4.m4a", 1.0)

        .addSound("cat1", "assets/audio_fx/12_cat1.m4a", 1.0)
        .addSound("cat2", "assets/audio_fx/11_cat2.m4a", 1.0)
        .addSound("cat3", "assets/audio_fx/10_cat3.m4a", 1.0)
        .addSound("cat4", "assets/audio_fx/9_cat4.m4a", 1.0)
        .addSound("cat5", "assets/audio_fx/8_cat5.m4a", 1.0)
        .addSound("cat6", "assets/audio_fx/7_cat6.m4a", 1.0)

        .addSound("tnt_blast", "assets/audio_fx/191.m4a", 1.0)
        .addSound("spike", "assets/audio_fx/203.m4a", 1.0)
        .addSound("swallow", "assets/audio_fx/222.m4a", 1.0)
        .addSound("trampoline", "assets/audio_fx/245.m4a", 1.0)
        .addSound("barrel", "assets/audio_fx/375.m4a", 1.0)
        .addSound("baloon_blast", "assets/audio_fx/378.m4a", 1.0)
        // .addSound("", "assets/audio_fx/311.m4a",1.0)
        // .addSound("", "assets/audio_fx/6_failure.m4a",1.0)
        .loadAll();
}


function gameLoop() {
    requestAnimationFrame(gameLoop);

    renderer.clear();

    if (skip_frames > 0) {
        skip_frames--;
        show_load_screen(skip_frames, max_skip_frames);
        return;
    }
    max_skip_frames = 0;
    skip_frames = 0;

    switch (CURRENT_GAME_SCREEN) {
        case GAME_SCREENS_E.Preload:
            preload_screen();
            break;
        case GAME_SCREENS_E.Splash:
            //splash_screen();
            break;
        case GAME_SCREENS_E.Menu:
            render_screen(menu_screen);
            break;
        case GAME_SCREENS_E.Credits:
            render_screen(credits_screen);
            break;
        case GAME_SCREENS_E.Help:
            render_screen(how_to_play_screen);
            break;
        case GAME_SCREENS_E.Play:
            render_game_screen();
            break;
    }

    // debug cursor position
    // let correct_pos = TouchController.map_coord_to_canvas(TouchController.TOUCH_INFORMATION.position, canvas);
    // ctx.fillStyle = "white";
    // ctx.strokeStyle = "black";
    // ctx.beginPath();
    // ctx.arc(correct_pos.x, correct_pos.y, 15, 0, Math.PI * 2);
    // ctx.closePath();
    // ctx.fill();
    // ctx.stroke();
}


//-[Screens]-------------------------------------------------
function show_load_screen(progress, max_progress) {
    ctx.fillStyle = "#dbedff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let frame = screens_sprite.getFrame("menu_screen.png");
    let frame_w = frame.getWidth();
    let frame_h = frame.getHeight();
    frame.draw(ctx, canvas.width / 2 - frame_w / 2, 0, frame_w, frame_h);
    let w = Math.floor(linearMap(progress, 0, max_progress, 0, canvas.width / 2));
    ctx.lineWidth = 2;
    ctx.fillStyle = "forestgreen";
    ctx.fillRect(canvas.width / 4 + 4, canvas.height / 2 + 4, w, 40);
    ctx.fillStyle = "lightgreen";
    ctx.fillRect(canvas.width / 4, canvas.height / 2, w, 40);
    ctx.fillStyle = "forestgreen";
    ctx.strokeRect(canvas.width / 4, canvas.height / 2, w, 40);
    ctx.font = "60px Nicotine";
    let text = "Loading ...";
    let font_w_half = ctx.measureText(text).width / 2;
    ctx.fillText(text, canvas.width / 2 - font_w_half, canvas.height / 2 + 100);
}

function preload_screen() {
    ctx.fillStyle = "#dbedff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let frame = screens_sprite.getFrame("menu_screen.png");
    // Centered at native aspect — stretching to a 4:1 canvas would distort it.
    let frame_w = canvas.height * (frame.getWidth() / frame.getHeight());
    frame.draw(ctx, canvas.width / 2 - frame_w / 2, 0, frame_w, canvas.height);


    let arc_r = 80;
    let arc_pos = new Vector2D(canvas.width / 2, canvas.height - arc_r - 80);

    if (sound_manager.loaded) { // play button


        //play button background circle
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.arc(arc_pos.x, arc_pos.y, arc_r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();

        //play button circle outline
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#FFF";
        ctx.beginPath();
        ctx.arc(arc_pos.x, arc_pos.y, arc_r - 4, 0, Math.PI * 2);
        ctx.closePath();
        ctx.stroke();

        // play Triangle

        ctx.fillStyle = "#FFF";
        ctx.save();

        let new_r = arc_r - 24;
        let eq_tri_vec = new Vector2D(-1, Math.sqrt(3)).scale((1 / 2) * (new_r));
        ctx.beginPath();
        ctx.translate(arc_pos.x, arc_pos.y);
        ctx.moveTo(new_r, 0);
        ctx.lineTo(eq_tri_vec.x, eq_tri_vec.y);
        ctx.lineTo(eq_tri_vec.x, -eq_tri_vec.y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();



		CURRENT_GAME_SCREEN = GAME_SCREENS_E.Menu;
		cannon.resetBarrel();



    } else {

        ctx.fillStyle = "#000";
        ctx.font = "30px Nicotine";
        let progress_width = 200;
        let text_w = ctx.measureText(preload_message).width;
        ctx.fillText(preload_message, arc_pos.x - text_w / 2, arc_pos.y);


        ctx.fillStyle = "forestgreen";
        ctx.fillRect(arc_pos.x - progress_width / 2 + 8, arc_pos.y + 50 + 8, progress_width * (preload_percentage / 100), 40);
        ctx.fillStyle = "#c0c0c0";
        ctx.fillRect(arc_pos.x - progress_width / 2, arc_pos.y + 50, progress_width, 40);
        ctx.fillStyle = "lightgreen";
        ctx.fillRect(arc_pos.x - progress_width / 2, arc_pos.y + 50, progress_width * (preload_percentage / 100), 40);

    }

}

function splash_screen() {
    let dt = timer.getTickS() * TIME_SCALE;
    grass.draw();
    cannon.draw();
    cannon.update(dt);
    if (sound_manager.getCurrentTime("after_load") > 4.1) {
        cannon.barrelShoot();
    } else {
        if (sound_manager.getCurrentTime("after_load") > 3.1) cannon.barrelUp();
    }
}

function render_screen(screen_class) {
    screen_class.draw();
    mute_button.draw();
    if (TouchController.TOUCH_INFORMATION.eventType == TouchController.TOUCH_EVENT_TYPES.down) {
        let correct_pos = TouchController.map_coord_to_canvas(TouchController.TOUCH_INFORMATION.position, canvas);
        if (mute_button.isPointInside(correct_pos)) {
            mute_button.updateClickInput(correct_pos);
        } else {
            screen_class.updateClickInput(correct_pos);
        }
        // Immediately reset the event type after processing
        TouchController.TOUCH_INFORMATION.eventType = TouchController.TOUCH_EVENT_TYPES.none;
    }
}

function render_game_screen() {
    // Add debug info here

               
    let dt = timer.getTickS();
    let fps = (1 / dt);
    ctx.font = "50px Nicotine";
    ctx.fillStyle = "#000";
    ctx.fillText("FPS : " + fps.toFixed(0), 30, 30);

    // if user gets window.onblur then the dt may be really high.
    // so we use Math.min
    dt = Math.min(dt, 1 / 20);
    dt *= TIME_SCALE;
    renderer.clear();
    handleKeyboardCallbacks();


    kitty.update(dt);
    height_display.updateWithKittenPosition(kitty.position);

    // Only update distance_travelled_px if kitty is alive and visible
    if (!(kitty.isDead) && kitty.visible) {
        distance_travelled_px += kitty.velocity.x * dt;
        distance_display.update(distance_travelled_px);
    }
    
    // Update the distance display with current distance - add this line


    let correct_pos = TouchController.map_coord_to_canvas(TouchController.TOUCH_INFORMATION.position, canvas);

    if (TouchController.TOUCH_INFORMATION.eventType == TouchController.TOUCH_EVENT_TYPES.down) {
        try {
            // When the score board is up, it owns the screen (mute still reachable).
            if (score_board.visible) {
                score_board.updateClickInput(correct_pos);
                mute_button.updateClickInput(correct_pos);
            } else {
                mute_button.updateClickInput(correct_pos);
                // Only an explicit FIRE tap (or Space) launches the kitten.
                fire_button.updateClickInput(correct_pos);
            }
        } catch (e) {
            console.error("Error in touch handling:", e);
        } finally {
            // Immediately reset the event type after processing to prevent multiple processing
            TouchController.TOUCH_INFORMATION.eventType = TouchController.TOUCH_EVENT_TYPES.none;
        }
    }

    // While the touch is held: arrows sweep the barrel (repeat every frame, like
    // holding W/S), and holding/dragging anywhere else points the barrel at the
    // finger — aiming is now completely separate from firing.
    if (TouchController.TOUCH_INFORMATION.isDown && !score_board.visible) {
        let held_pos = TouchController.map_coord_to_canvas(TouchController.TOUCH_INFORMATION.position, canvas);
        if (up_button.isPointInside(held_pos)) {
            cannon.barrelUp();
        } else if (down_button.isPointInside(held_pos)) {
            cannon.barrelDown();
        } else if (!kitty.visible && !kitty.isDead
            && !fire_button.isPointInside(held_pos) && !mute_button.isPointInside(held_pos)) {
            aimAtPosition(held_pos);
        }
    }

    objectGenerator.update(dt);
    cannon.update(dt);


    if (kitty.position.x >= kitty.virtualPosXMax) {
        camera.follow(kitty.position.copy().subtract(new Vector2D(0, 0)), 0.5);
    } else {
        camera.follow(new Vector2D(canvas.width / 2, canvas.height / 2));
    }


    if (kitty.isDead) {
        handle_highScore();
        
        // Only fetch high score once when the kitten dies
        if (!highScoreFetched) {
            highScoreFetched = true;
            const finalScore = Math.floor(distance_travelled_px / pixel_per_feet);
            fetchGlobalHighScore(finalScore);
            fetchLeaderboard();   // refreshed again via KC_ON_SCORE_SAVED once this run's score lands
        }
        
        score_board.visible = true;
    }

    { // SCORE BOARD
        let distance_travelled = (distance_travelled_px / pixel_per_feet).toFixed(0);
        
        // Only update distance_travelled_px if kitty is alive and visible
        if (!(kitty.isDead) && kitty.visible) {
            distance_travelled_px += kitty.velocity.x * dt;
        }
        
        // If distance_travelled_px increased beyond highest_distance_travelled_px,
        // update highest_distance_travelled_px and personalBestDisplay
        if (distance_travelled_px > highest_distance_travelled_px) {
            highest_distance_travelled_px = distance_travelled_px;
            personalBestDisplay = (highest_distance_travelled_px / pixel_per_feet).toFixed(0);
        }
        
        // Make all score variables available globally
        window.distance_travelled_px = distance_travelled_px;
        window.distance_travelled = distance_travelled;
        window.gameScore = distance_travelled;
        
        // Update scores on scoreboard
        score_board.score = distance_travelled; 
        score_board.highScore = personalBestDisplay; // Use our persistent display value
        score_board.globalHighScore = globalHighScore;
        
        // Only use mock percentile if we don't have a server-provided one already
        if (score_board.percentile === 0 || score_board.percentile === undefined) {
            let mockPercentile = Math.min(99, Math.floor((distance_travelled / 2000) * 100));
            score_board.percentile = mockPercentile;
        }
        
        score_board.draw();
    }

    grass.draw();
    cannon.draw();
    kitty.draw();
    height_display.draw();
    distance_display.draw(); // Draw the distance display

    objectGenerator.drawAll();

    // UI on top of everything; hide the play controls once the run is over.
    up_button.visible = down_button.visible = fire_button.visible = !kitty.isDead;
    up_button.draw();
    down_button.draw();
    fire_button.draw();
    mute_button.draw();


    if (should_reset) reset_game();
}


//-[/Screens]-------------------------------------------------

//-[Helpers]-------------------------------------------------

function hide_buttons() {
    // fire_button.visible = false;
    // up_button.visible = false;
    // down_button.visible = false;
}



function handle_highScore() {
    if (distance_travelled_px > highest_distance_travelled_px) {
        highest_distance_travelled_px = distance_travelled_px;
        personalBestDisplay = (highest_distance_travelled_px / pixel_per_feet).toFixed(0);
        
        // If this is a new personal best and the user is logged in,
        // you might want to submit it to the server and refresh the global high score
        if (window.userId) {
            submitScore(distance_travelled_px / pixel_per_feet);
            fetchGlobalHighScore(); // Refresh the global high score
        }
    }
}

// The per-run server save lives in Kitten.js (saveScore, once per death);
// this only keeps the local offline store current.
async function submitScore(score) {
    saveLocalScore(score);
}

function throw_kitty() {
    if (!kitty.visible && !kitty.isDead) {
        // Don't hide UI elements when firing
        // Remove any hide_buttons() calls here
        
        cannon.barrelShoot();
        let barrelDir = cannon.getBarrelDirectionVector();
        kitty.visible = true;
        kitty.position = cannon.getBarrelEnd()
            .subtract(barrelDir.copy().scale(32))
            .subtract(new Vector2D(kitty.width / 2, kitty.height / 2));
        kitty.throw(barrelDir.scale((cannon.powerPercent / 100) * 46));

        if (Math.random() < 0.4) {
            sound_manager.play("cat" + randomInt(1, 6))
        }
        sound_manager.play("baloon_blast");
        
        // Debug message
        console.log("Kitten fired at angle:", cannon.barrel_angle, 
                   "power:", cannon.powerPercent);
    }
}

function aimAtPosition(position) {
    // Point the barrel from the cannon toward the touched position — no firing;
    // that's the FIRE button's (or Space bar's) job.
    const cannonPos = cannon.getBarrelStart();
    const aimDirection = position.copy().subtract(cannonPos);
    cannon.aimAt(aimDirection);
}

async function fetchGlobalHighScore(optionalScore = null) {
    // Don't fetch if we're already fetching or if it's been less than MIN_FETCH_INTERVAL since last fetch
    if (fetchingHighScore || (Date.now() - lastFetchTime < MIN_FETCH_INTERVAL)) {
        console.log("High score fetch skipped - too frequent or already in progress");
        return;
    }
    
    if (!SCORE_SERVER) {
        globalHighScore = String(localGlobalBest());
        return;
    }

    try {
        fetchingHighScore = true;
        lastFetchTime = Date.now();

        // Rest of your existing code...
        const currentScore = optionalScore !== null ?
            optionalScore :
            Math.floor(distance_travelled_px / pixel_per_feet);

        console.log("Fetching high score for score:", currentScore);

        const response = await fetch(serverApi(`get_high_score.php?game=${GAME_SLUG}&score=${currentScore}`));
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Update the global high score
        if (data && data.highScore) {
            globalHighScore = data.highScore;
            
            if (data.percentile !== undefined && score_board) {
                score_board.percentile = data.percentile;
            }
        }
    } catch (e) {
        console.error('Error fetching global high score:', e);
    } finally {
        // Always reset the fetching flag when done
        fetchingHighScore = false;
    }
}

// Modify fetchPersonalHighScore to save the display value
async function fetchPersonalHighScore() {
    if (!window.userId) {
        console.log("No user ID, skipping personal high score fetch");
        return;
    }

    if (!SCORE_SERVER) {
        const best = localPersonalBest();
        if (best > 0) {
            personalBestDisplay = String(best);
            highest_distance_travelled_px = Math.max(highest_distance_travelled_px, best * pixel_per_feet);
        }
        return;
    }

    try {
        console.error("Fetching personal best for user:", window.userId);
        const response = await fetch(serverApi(`get_personal_high_score.php?game=${GAME_SLUG}&userId=${encodeURIComponent(window.userId)}`));

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // personalHighScore is null when the player has no scores yet.
        if (data.success && data.personalHighScore) {
            console.error("Personal best retrieved:", data.personalHighScore);
            
            // Store the display value
            personalBestDisplay = data.personalHighScore;
            
            // Convert feet (from DB) to pixels (game uses pixels internally)
            const highScoreInPixels = parseInt(data.personalHighScore) * pixel_per_feet;
            
            // Update the game's high score variable
            highest_distance_travelled_px = Math.max(highest_distance_travelled_px, highScoreInPixels);
        }
        else {
            console.error("Could not retrieve personal best.");
        }
    } catch (e) {
        console.error('Error fetching personal high score:', e);
    }
}

// Best score per player, for the score board's side panel. Online it comes from
// the server; offline it's built from this PC's local bests, so it still works.
async function fetchLeaderboard() {
    if (!score_board) return;
    score_board.playerTag = window.userId || "";
    if (!SCORE_SERVER) {
        score_board.leaderboard = Object.entries(localScores())
            .map(([userid, score]) => ({ userid: String(userid).toUpperCase(), score: Math.floor(score) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 8)
            .map((e, i) => ({ rank: i + 1, userid: e.userid, score: e.score }));
        score_board.leaderboardLoaded = true;
        return;
    }
    try {
        // runs=1: top individual runs, arcade style (same initials can repeat).
        // Servers without that mode ignore it and send best-per-player instead.
        const response = await fetch(serverApi(`get_leaderboard.php?game=${GAME_SLUG}&limit=8&runs=1`));
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (data && data.success && Array.isArray(data.leaderboard)) {
            score_board.leaderboard = data.leaderboard;
            score_board.leaderboardLoaded = true;
            // The top entry IS the world record; this heals a stale/failed
            // get_high_score fetch without an extra (rate-limited) call.
            const top = data.leaderboard[0];
            if (top && parseInt(top.score) > parseInt(globalHighScore || "0")) {
                globalHighScore = String(top.score);
            }
        }
    } catch (e) {
        console.error('Error fetching leaderboard:', e);
    }
}

// On the Bedrock Panel panel the page already fills the screen; grabbing fullscreen
// from inside the host's webview would fight the panel window.
if (!EMBEDDED_IN_HOST) addEventListener("click", goFullScreen);

function goFullScreen() {
    if ("requestFullscreen" in document.body) {
        document.body.requestFullscreen().catch(err => {
            console.log("no full screen support");
        });
    }
    if ('wakelock' in navigator) {
        navigator.wakeLock.request('screen').then(() => {
            console.log("wakelock aquired");
        }).catch(err => {
            console.log("failed aquiring wakelock");
        });
    }
}
function resize() {
    if (canvas) {
        TouchController.resetTouchInfo();

        let canvas_ar = canvas.width / canvas.height;
        let portrait_width = canvas_ar * innerHeight;
        if (portrait_width < innerWidth) {
            canvas.style.width = 'auto';
            canvas.style.height = '100vh';
        } else {
            canvas.style.width = '100vw';
            canvas.style.height = 'auto';
            portrait_width = innerWidth;
        }
        canvas.classList.remove('landscape');


        let landscape_width = canvas_ar * innerWidth;
        if (landscape_width < innerHeight) {
            if (landscape_width > portrait_width) {
                canvas.style.height = '100vw';
                canvas.style.width = 'auto';
                canvas.classList.add('landscape');
            }
        } else {
            landscape_width = innerHeight;
            if (landscape_width > portrait_width) {
                canvas.style.height = 'auto';
                canvas.style.width = '100vh';
                canvas.classList.add('landscape');
            }
        }
    }
}

onresize = resize;
//-[/Helpers]-------------------------------------------------