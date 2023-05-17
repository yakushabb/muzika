import Gst from "gi://Gst";
import GObject from "gi://GObject";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import type { QueueTrack } from "libmuse/types/parsers/queue.js";

import { Queue, QueueSettings } from "./queue.js";
import { AudioFormat, get_song, Song } from "../muse.js";
import { Settings } from "../application.js";
import { ObjectContainer } from "../util/objectcontainer.js";
import { AddActionEntries } from "src/util/action.js";

const preferred_quality: AudioFormat["audio_quality"] = "medium";
const preferred_format: AudioFormat["audio_codec"] = "opus";

type MaybeAdaptiveFormat = AudioFormat & {
  adaptive: boolean;
};

export type TrackMetadata = {
  song: Song;
  format: MaybeAdaptiveFormat;
  track: QueueTrack;
  options: QueueSettings;
};

export class Player extends GObject.Object {
  static {
    GObject.registerClass({
      GTypeName: "Player",
      Properties: {
        queue: GObject.param_spec_object(
          "queue",
          "Queue",
          "The queue",
          Queue.$gtype,
          GObject.ParamFlags.READABLE,
        ),
        current: GObject.param_spec_object(
          "current",
          "Current",
          "The current song",
          ObjectContainer.$gtype,
          GObject.ParamFlags.READABLE,
        ),
        is_live: GObject.param_spec_boolean(
          "is-live",
          "Is live",
          "Whether the current song is live",
          false,
          GObject.ParamFlags.READABLE,
        ),
        buffering: GObject.param_spec_boolean(
          "buffering",
          "Buffering",
          "Whether the player is buffering",
          false,
          GObject.ParamFlags.READABLE,
        ),
        playing: GObject.param_spec_boolean(
          "playing",
          "Playing",
          "Whether the player is playing",
          false,
          GObject.ParamFlags.READABLE,
        ),
        position: GObject.param_spec_uint64(
          "position",
          "Position",
          "The current position",
          0,
          Number.MAX_SAFE_INTEGER,
          0,
          GObject.ParamFlags.READABLE,
        ),
        duration: GObject.param_spec_uint64(
          "duration",
          "Duration",
          "The duration of the current song",
          0,
          Number.MAX_SAFE_INTEGER,
          0,
          GObject.ParamFlags.READABLE,
        ),
      },
    }, this);
  }

  playbin: Gst.Element;
  fakesink: Gst.Element;

  private _is_live = false;

  get is_live() {
    return this._is_live;
  }

  private set is_live(value: boolean) {
    this._is_live = value;
    this.notify("is-live");
  }

  private _buffering = true;

  get buffering() {
    return this._buffering;
  }

  private set buffering(value: boolean) {
    this._buffering = value;
    this.notify("buffering");
  }

  private _playing = false;

  get playing() {
    return this._playing;
  }

  private set playing(value: boolean) {
    this._playing = value;
    this.notify("playing");
  }

  private _queue: Queue = new Queue();

  get queue(): Queue {
    return this._queue;
  }

  private _current: ObjectContainer<TrackMetadata> | null = null;

  get current() {
    return this._current;
  }

  private _position = 0;

  get position() {
    return this._position;
  }

  private set position(value: number) {
    this._position = value;
    this.notify("position");
  }

  get_position() {
    const [ret, pos] = this.playbin.query_position(Gst.Format.TIME);

    if (ret) {
      return pos;
    } else {
      return null;
    }
  }

  private _duration = 0;

  get duration() {
    return this._duration;
  }

  private set duration(value: number) {
    this._duration = value;
    this.notify("duration");
  }

  get_duration() {
    const [ret, dur] = this.playbin.query_duration(Gst.Format.TIME);

    if (ret) {
      return dur;
    } else {
      return null;
    }
  }

  async = false;

  constructor() {
    super();

    if (!Gst.is_initialized()) {
      Gst.init(null);
    }

    this.queue.connect("notify::current", () => {
      this.change_current_track(this.queue.current?.item ?? null);
    });

    this.queue.connect("wants-to-play", () => {
      this.playing = true;
    });

    this.playbin = Gst.ElementFactory.make("playbin", "player")!;
    this.fakesink = Gst.ElementFactory.make("fakesink", "fakesink")!;

    this.playbin.set_property("video-sink", this.fakesink);

    const bus = this.playbin.get_bus()!;
    bus.add_signal_watch();
    bus.connect("message", this.on_message.bind(this));

    Settings.connect("changed::volume", () => {
      this.playbin.set_property("volume", Settings.get_double("volume"));
    });

    this.playbin.set_property("volume", Settings.get_double("volume"));
  }

  get_action_group() {
    const action_group = Gio.SimpleActionGroup.new();

    (action_group.add_action_entries as AddActionEntries)([
      {
        name: "play",
        activate: () => {
          this.play();
        },
      },
      {
        name: "pause",
        activate: () => {
          this.pause();
        },
      },
      {
        name: "play-pause",
        activate: () => {
          this.play_pause();
        },
      },
      {
        name: "previous",
        activate: () => {
          this.previous();
        },
      },
      {
        name: "next",
        activate: () => {
          this.next();
        },
      },
      {
        name: "seek",
        parameter_type: "d",
        activate: (_action, param: GLib.Variant<"d"> | null) => {
          if (!param) return;
          this.seek(param.get_double());
        },
      },
    ]);

    this.connect("notify::playing", () => {
      action_group.action_enabled_changed("play", !this.playing);
      action_group.action_enabled_changed("pause", this.playing);
    });

    action_group.action_enabled_changed("play", !this.playing);
    action_group.action_enabled_changed("pause", this.playing);

    this.queue.connect("notify::can-play-previous", () => {
      action_group.action_enabled_changed(
        "previous",
        this.queue.can_play_previous,
      );
    });

    action_group.action_enabled_changed(
      "previous",
      this.queue.can_play_previous,
    );

    this.queue.connect("notify::can-play-next", () => {
      action_group.action_enabled_changed("next", this.queue.can_play_next);
    });

    action_group.action_enabled_changed("next", this.queue.can_play_next);

    return action_group;
  }

  play() {
    if (
      this.playbin.get_state(Number.MAX_SAFE_INTEGER)[1] === Gst.State.PLAYING
    ) return;

    this.playing = true;
    const ret = this.playbin.set_state(Gst.State.PLAYING);

    if (ret === Gst.StateChangeReturn.FAILURE) {
      this.pause();
      throw new Error("Failed to play");
    } else if (ret === Gst.StateChangeReturn.NO_PREROLL) {
      this.is_live = true;
    }
  }

  pause() {
    this.playing = false;
    if (
      this.playbin.get_state(Number.MAX_SAFE_INTEGER)[1] === Gst.State.PLAYING
    ) {
      this.playbin.set_state(Gst.State.PAUSED);
    }
  }

  play_pause() {
    const state = this.playbin.get_state(Number.MAX_SAFE_INTEGER)[1];

    if (state === Gst.State.PLAYING) {
      this.pause();
    } else {
      this.play();
    }
  }

  private seek_id: number | null = null;

  private do_seek(position: number) {
    this.playbin.seek_simple(
      Gst.Format.TIME,
      Gst.SeekFlags.FLUSH,
      position,
    );
  }

  private remove_seek_cb() {
    if (!this.seek_id) return;
    this.disconnect(this.seek_id);
    this.seek_id = null;
  }

  seek(position: number) {
    // seek after buffering is complete
    if (this.buffering) {
      this.remove_seek_cb();

      this.seek_id = this.connect("notify::buffering", () => {
        if (this.buffering) return;
        this.do_seek(position);

        this.remove_seek_cb();
      });
    } else {
      // seek immediately
      this.do_seek(position);
    }
  }

  async previous() {
    this.playing = true;
    this.queue.previous();
  }

  async next() {
    this.playing = true;
    this.queue.next();
  }

  async repeat_or_next() {
    this.queue.repeat_or_next();
  }

  stop() {
    this.playing = false;
    this.playbin.set_state(Gst.State.NULL);
  }

  song_cache = new Map<string, Song>();

  async get_song(videoId: string) {
    if (!this.song_cache.has(videoId)) {
      this.song_cache.set(videoId, await get_song(videoId));
    }

    return this.song_cache.get(videoId)!;
  }

  async change_current_track(track: QueueTrack | null) {
    this.playbin.set_state(Gst.State.NULL);

    if (!track) {
      return;
    }

    const [song, track_options] = await Promise.all([
      this.get_song(track.videoId),
      this.queue.get_track_settings(track.videoId),
    ]);

    const format = this.negotiate_best_format(song);

    this._current = ObjectContainer.new({
      song,
      track,
      format,
      options: track_options,
    });
    this.notify("current");

    this.playbin.set_state(Gst.State.NULL);
    this.playbin.set_property("uri", format.url);

    if (this.playing) this.play();
  }

  private on_message(_bus: Gst.Bus, message: Gst.Message) {
    const type = message.type;

    const [position_available, position] = this.playbin.query_position(
      Gst.Format.TIME,
    );

    if (position_available) {
      this.position = position;
    }

    switch (type) {
      case Gst.MessageType.EOS:
        this.repeat_or_next();
        break;
      case Gst.MessageType.ERROR:
        this.stop();
        const [error, debug] = message.parse_error();
        console.log("Error: ", error, debug);
      case Gst.MessageType.CLOCK_LOST:
        this.playbin.set_state(Gst.State.PAUSED);
        this.playbin.set_state(Gst.State.PLAYING);
        break;
      case Gst.MessageType.BUFFERING:
        const percent = message.parse_buffering();

        if (this._is_live) return;

        if (percent < 100) {
          if (!this.buffering && this.playing) {
            this.playbin.set_state(Gst.State.PAUSED);
          }

          this.buffering = true;
        } else {
          this.buffering = false;

          if (this.playing) this.playbin.set_state(Gst.State.PLAYING);
        }
        break;
      case Gst.MessageType.ASYNC_DONE:
        this.duration = this.get_duration() ?? 0;
        break;
    }
  }

  private get_format_points(format: MaybeAdaptiveFormat) {
    let points = 0;

    if (format.audio_quality === preferred_quality) {
      points += 5;
    }

    if (format.audio_codec === preferred_format) {
      points += 1;
    }

    if (format.adaptive) {
      points += 1;
    }

    switch (format.audio_quality) {
      case "tiny":
        points += 1;
        break;
      case "low":
        points += 2;
        break;
      case "medium":
        points += 3;
        break;
      case "high":
        points += 4;
        break;
    }

    return points;
  }

  private negotiate_best_format(song: Song) {
    const formats = this.get_audio_formats(song);

    return formats.sort((a, b) => {
      return this.get_format_points(b) - this.get_format_points(a);
    })[0];
  }

  private get_audio_formats(song: Song) {
    const formats = [
      ...song.formats.map((format) => {
        return {
          ...format,
          adaptive: false,
        };
      }),
      ...song.adaptive_formats.map((format) => {
        return {
          ...format,
          adaptive: true,
        };
      }),
    ];

    return formats
      .filter((format) => {
        return format.has_audio;
      }) as MaybeAdaptiveFormat[];
  }
}