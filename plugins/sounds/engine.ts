// Everything that makes a sound in the page. One engine per page, so music keeps playing and
// cues keep their time while people move between an event's pages.
//
// Uploads are played two ways. Short ones (effects) are fetched and decoded into memory once, so
// they start the instant their signal arrives. Long ones (songs) stream through an <audio>
// element, since a decoded three-minute song is tens of megabytes; "preload" asks the browser to
// buffer it early. Both are cached by the browser between visits like any other file.
import { playBuiltin, Generator, type MusicStyle } from "./synth.ts";
import { BUILTIN_MS, cueAction, type Effect, type PlannedCue, type SoundRef } from "./schedule.ts";

export interface LibraryFile {
  id: string;
  name: string;
  url: string;
  /** Plays from someone else's server, which may not let a page fetch it, only play it. */
  linked: boolean;
  durationMs: number;
  preload: boolean;
}

export type Background =
  | { kind: "generated"; style: MusicStyle; tempo: number }
  | { kind: "stream"; url: string; name: string }
  | { kind: "playlist"; tracks: Tuple<string> };

export interface PlayerState {
  /** Background music is on (it may be paused under a cue). */
  playing: boolean;
  background: Background | null;
  /** What background music couldn't do, with why. */
  error: string | null;
  /** The browser is holding sound back until the person interacts with the page. */
  blocked: boolean;
  /** The cue playing now, if any. */
  cue: { label: string; endsAt: number } | null;
  /** The track of the playlist playing now. */
  track: string | null;
  /** Which play button's sound is being tried out now, by the key it passed to `preview`. */
  previewing: string | null;
}

/** Uploads up to this long are decoded into memory; longer ones stream. */
const SHORT_MS = 20_000;
/** Cue sounds are fetched this long before they start, when they aren't preloaded. */
const WARM_MS = 90_000;
/** An effect that took longer than this to load is dropped: a late "ding" is worse than none. */
const EFFECT_PATIENCE_MS = 1500;
/** How far a streamed cue can drift from everyone else's before it's put back in step. */
const DRIFT_MS = 300;

/** What background music drops to while an effect plays, how long that takes, and the wait after. */
const UNDER = 0.25;
const UNDER_FADE_MS = 250;
const UNDER_TICK_MS = 25;
const UNDER_WAIT_MS = 400;
const FALLBACK_EFFECT_MS = 2000;

const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

class Engine {
  private context: AudioContext | null = null;
  private effectsBus: GainNode | null = null;
  /** Background music: generated, and silent while a music cue plays. */
  private musicBus: GainNode | null = null;
  /** Music cues: the music level, never ducked. */
  private cueBus: GainNode | null = null;
  private listeners = new Set<() => void>();
  private levels = { effects: 0.7, music: 0.5, muted: false, duckMusic: true };
  /** Tries things out at the person's levels, whether or not they've turned event sounds off. */
  private previewBus: GainNode | null = null;
  /** How much of its level background music keeps while effects play, 0 to 1. */
  private under = 1;
  private underTimer: ReturnType<typeof setInterval> | null = null;
  private underRelease: ReturnType<typeof setTimeout> | null = null;
  /** Effects sounding now, which hold the music down. */
  private effectsSounding = 0;
  /** Elements being tried out, which ignore muting. */
  private previewing = new Set<HTMLAudioElement>();

  private library = new Map<string, LibraryFile>();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private elements = new Map<string, HTMLAudioElement>();
  /** Elements playing now and their own volume, so level changes reach them. */
  private live = new Map<HTMLAudioElement, number>();

  private generator: Generator | null = null;
  private backgroundElement: HTMLAudioElement | null = null;
  private trackIndex = 0;
  private ducked = false;

  private cues: PlannedCue[] = [];
  private cueTimer: number | null = null;
  /** Cues already started or let go, by id and start time, so a moved cue plays again. */
  private handled = new Set<string>();
  private current: { plan: PlannedCue; stop: () => void } | null = null;

  state: PlayerState = {
    playing: false,
    background: null,
    error: null,
    blocked: false,
    cue: null,
    track: null,
    previewing: null,
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = () => this.state;
  private set(change: Partial<PlayerState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }

  // ── the audio graph ────────────────────────────────────────────────

  /** Created on first use; a browser keeps it suspended until the page has been interacted with. */
  private audio(): AudioContext | null {
    if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
    if (!this.context) {
      this.context = new AudioContext();
      this.effectsBus = this.context.createGain();
      this.musicBus = this.context.createGain();
      this.cueBus = this.context.createGain();
      this.previewBus = this.context.createGain();
      for (const bus of [this.effectsBus, this.musicBus, this.cueBus, this.previewBus]) {
        bus.connect(this.context.destination);
      }
      this.applyLevels();
      // anything the person does lets sound start, including what was held back
      const wake = () => this.unlock();
      window.addEventListener("pointerdown", wake, { capture: true });
      window.addEventListener("keydown", wake, { capture: true });
      document.addEventListener("visibilitychange", () => this.runCues());
    }
    if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
    return this.context;
  }

  /** Lets sound start, and starts what the browser held back; any click on the page does this too. */
  unlock() {
    const context = this.context;
    if (!context) return;
    const retry = () => {
      if (!this.state.blocked) return;
      this.set({ blocked: false });
      // a cue held back starts now, in step with everyone else, and so does held-back music
      this.runCues();
      if (this.state.playing && !this.ducked) this.resumeBackground();
    };
    if (context.state === "suspended") void context.resume().then(retry, () => undefined);
    else retry();
  }

  private applyLevels() {
    const now = this.context?.currentTime ?? 0;
    const { effects, music, muted } = this.levels;
    this.effectsBus?.gain.setTargetAtTime(muted ? 0 : effects, now, 0.05);
    // generated music is dense, so it sits a little under the level
    this.musicBus?.gain.setTargetAtTime(
      muted || this.ducked ? 0 : music * 0.6 * this.under,
      now,
      0.1,
    );
    this.cueBus?.gain.setTargetAtTime(muted ? 0 : music, now, 0.05);
    for (const [element, volume] of this.live) element.volume = this.elementVolume(element, volume);
  }

  private elementVolume(element: HTMLAudioElement, volume: number) {
    if (this.previewing.has(element)) return clamp(this.levels.music * volume);
    if (this.levels.muted) return 0;
    if (element === this.backgroundElement) {
      return this.ducked ? 0 : clamp(this.levels.music * volume * this.under);
    }
    return clamp(this.levels.music * volume);
  }

  /** The person's own levels, each 0 to 1. */
  setLevels(levels: { effects: number; music: number; muted: boolean; duckMusic: boolean }) {
    const wasMuted = this.levels.muted;
    this.levels = {
      effects: clamp(levels.effects),
      music: clamp(levels.music),
      muted: levels.muted,
      duckMusic: levels.duckMusic,
    };
    if (!levels.duckMusic) this.effectsSounding = 0;
    this.moveUnder(this.effectsSounding > 0 ? UNDER : 1);
    // muted, background music stops downloading and generating; it picks up again when unmuted
    if (levels.muted && !wasMuted) this.pauseBackground();
    if (!levels.muted && wasMuted && !this.ducked) this.resumeBackground();
  }

  // ── the library ────────────────────────────────────────────────────

  /** The event's uploads. Ones marked to preload start loading now. */
  setLibrary(files: Tuple<LibraryFile>) {
    const ids = new Set(files.map((file) => file.id));
    for (const id of this.library.keys()) {
      if (ids.has(id)) continue;
      this.buffers.delete(id);
      this.elements.delete(id);
    }
    this.library = new Map(files.map((file) => [file.id, file]));
    for (const file of files) if (file.preload) this.load(file.id);
    this.runCues();
  }

  /** How long a sound is, or null for an upload that isn't in the library. */
  lengthOf = (sound: SoundRef): number | null =>
    sound.kind === "builtin"
      ? BUILTIN_MS[sound.name]
      : (this.library.get(sound.id)?.durationMs ?? null);

  // decoding needs the file fetched, which a linked host has to allow (CORS); an <audio>
  // element plays from anywhere, so linked sounds always stream
  private isShort(file: LibraryFile) {
    return !file.linked && file.durationMs <= SHORT_MS;
  }

  /** Starts fetching an upload, once. */
  load(id: string) {
    const file = this.library.get(id);
    if (!file) return;
    if (this.isShort(file)) void this.buffer(file);
    else this.element(file);
  }

  private buffer(file: LibraryFile): Promise<AudioBuffer | null> {
    const known = this.buffers.get(file.id);
    if (known) return known;
    const context = this.audio();
    if (!context) return Promise.resolve(null);
    const loading = fetch(file.url)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(response.status)))
      .then((data) => context.decodeAudioData(data))
      .catch((error: unknown) => {
        console.warn(`[sounds] couldn't load "${file.name}"`, error);
        // forget it, so a later play tries again
        this.buffers.delete(file.id);
        return null;
      });
    this.buffers.set(file.id, loading);
    return loading;
  }

  private element(file: LibraryFile): HTMLAudioElement {
    const known = this.elements.get(file.id);
    if (known) return known;
    const element = new Audio();
    element.preload = "auto";
    element.src = file.url;
    this.elements.set(file.id, element);
    return element;
  }

  // ── playing one sound ──────────────────────────────────────────────

  /** Whether the audio clock runs, waiting a moment for one that's just been asked to resume. */
  private async running(context: AudioContext): Promise<boolean> {
    // read through a function: TypeScript would otherwise keep the narrowing across the await
    const runs = () => context.state === "running";
    if (runs()) return true;
    const resumed = context.resume().then(
      () => true,
      () => false,
    );
    const late = new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 300));
    if ((await Promise.race([resumed, late])) && runs()) return true;
    this.set({ blocked: true });
    return false;
  }

  /**
   * Plays a sound on a channel, `fromMs` into it. Resolves to a function that stops it, or null
   * when it couldn't play; `blocked` is set when that's the browser waiting for a click. With
   * `patience`, an upload that takes longer than that to load doesn't play.
   */
  private async play(
    sound: SoundRef,
    channel: "music" | "effect",
    volume: number,
    {
      fromMs = 0,
      patience,
      preview = false,
      onEnd,
    }: {
      fromMs?: number;
      patience?: number;
      preview?: boolean;
      /** Called when it plays to the end by itself. */
      onEnd?: () => void;
    } = {},
  ): Promise<(() => void) | null> {
    const asked = Date.now();
    const context = this.audio();
    const bus = preview ? this.previewBus : channel === "music" ? this.cueBus : this.effectsBus;
    if (!context || !bus) return null;
    const file = sound.kind === "file" ? this.library.get(sound.id) : undefined;
    if (sound.kind === "file" && !file) return null;

    if (file && !this.isShort(file)) {
      const element = this.element(file);
      element.currentTime = fromMs / 1000;
      if (preview) this.previewing.add(element);
      this.live.set(element, volume);
      element.volume = this.elementVolume(element, volume);
      try {
        await element.play();
      } catch (error) {
        this.live.delete(element);
        this.previewing.delete(element);
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          this.set({ blocked: true });
        } else console.warn(`[sounds] couldn't play "${file.name}"`, error);
        return null;
      }
      const ended = () => onEnd?.();
      element.addEventListener("ended", ended, { once: true });
      return () => {
        element.removeEventListener("ended", ended);
        element.pause();
        this.live.delete(element);
        this.previewing.delete(element);
      };
    }

    const buffer = file ? await this.buffer(file) : null;
    if (file && !buffer) return null;
    if (patience !== undefined && Date.now() - asked > patience) return null;
    if (!(await this.running(context))) return null;
    const gain = context.createGain();
    gain.gain.value = clamp(volume);
    gain.connect(bus);
    if (!buffer) {
      if (sound.kind === "builtin") playBuiltin(context, gain, sound.name, fromMs / 1000);
      const timer = onEnd
        ? setTimeout(onEnd, Math.max(0, (this.lengthOf(sound) ?? FALLBACK_EFFECT_MS) - fromMs))
        : null;
      return () => {
        if (timer) clearTimeout(timer);
        gain.disconnect();
      };
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => onEnd?.();
    source.start(0, fromMs / 1000);
    return () => {
      source.onended = null;
      source.stop();
      gain.disconnect();
    };
  }

  /** Plays an effect now, if the person hasn't turned effects off. */
  effect(effect: Effect) {
    if (!effect.sound || this.levels.muted || this.levels.effects === 0) return;
    this.holdMusic(effect.sound);
    // a late "ding" is worse than none
    void this.play(effect.sound, "effect", effect.volume / 100, { patience: EFFECT_PATIENCE_MS });
  }

  /** Keeps background music down for as long as an effect sounds, and a moment after. */
  private holdMusic(sound: SoundRef) {
    if (!this.levels.duckMusic) return;
    this.effectsSounding += 1;
    if (this.underRelease) clearTimeout(this.underRelease);
    this.moveUnder(UNDER);
    const length = this.lengthOf(sound) ?? FALLBACK_EFFECT_MS;
    setTimeout(() => {
      this.effectsSounding = Math.max(0, this.effectsSounding - 1);
      if (this.effectsSounding > 0) return;
      this.underRelease = setTimeout(() => this.moveUnder(1), UNDER_WAIT_MS);
    }, length);
  }

  /** Fades background music to a share of its level. */
  private moveUnder(target: number) {
    if (this.underTimer) clearInterval(this.underTimer);
    this.underTimer = setInterval(() => {
      const step = (1 - UNDER) / (UNDER_FADE_MS / UNDER_TICK_MS);
      this.under =
        target < this.under ? Math.max(target, this.under - step) : Math.min(target, this.under + step);
      this.applyLevels();
      if (this.under === target && this.underTimer) {
        clearInterval(this.underTimer);
        this.underTimer = null;
      }
    }, UNDER_TICK_MS);
  }

  /**
   * Plays a sound once from the top, for trying one out, stopping whatever was being tried. `key`
   * names the button that asked, so it can show Stop until the sound ends (`state.previewing`).
   */
  preview(sound: SoundRef, channel: "music" | "effect", key: string) {
    this.unlock();
    this.stopPreview();
    // a newer preview, or Stop, makes an older one's late start or end a no-op
    const token = this.previewToken;
    const current = () => token === this.previewToken;
    const context = this.audio();
    if (context && this.previewBus) {
      this.previewBus.gain.value = channel === "music" ? this.levels.music : this.levels.effects;
    }
    if (channel === "effect") this.holdMusic(sound);
    this.set({ previewing: key });
    void this.play(sound, channel, 1, {
      preview: true,
      onEnd: () => {
        if (current()) this.stopPreview();
      },
    }).then((stop) => {
      if (!current()) return stop?.();
      if (stop) this.previewStop = stop;
      else this.stopPreview();
    });
  }
  private previewStop: (() => void) | null = null;
  private previewToken = 0;
  stopPreview() {
    this.previewToken += 1;
    this.previewStop?.();
    this.previewStop = null;
    if (this.state.previewing !== null) this.set({ previewing: null });
  }

  // ── background music ───────────────────────────────────────────────

  /** What starting background music plays; changing it while it plays switches over. */
  setBackground(background: Background | null) {
    if (JSON.stringify(background) === JSON.stringify(this.state.background)) return;
    const wasPlaying = this.state.playing;
    this.stopBackground();
    this.set({ background, error: null });
    if (wasPlaying && background) this.startBackground();
  }

  /** Starts background music now, or at the first click or key if the browser is holding sound back. */
  startBackground() {
    const { background } = this.state;
    if (!background) return;
    // sets up the listeners for that first click or key
    this.audio();
    this.unlock();
    this.set({ playing: true, error: null });
    if (this.ducked) return; // starts when the cue ends
    this.resumeBackground();
  }

  private resumeBackground() {
    const { background } = this.state;
    if (!background || !this.state.playing || this.levels.muted) return;
    if (background.kind === "generated") {
      const context = this.audio();
      if (!context || !this.musicBus) {
        this.set({ playing: false, error: "This browser can't play generated music." });
        return;
      }
      this.generator?.stop();
      this.generator = new Generator(context, this.musicBus, background.style, background.tempo);
      this.generator.start();
      this.applyLevels();
      return;
    }
    if (background.kind === "stream") {
      const element = this.backgroundElement ?? new Audio(background.url);
      // a single file given as the "stream" goes round again; a live stream never ends anyway
      element.loop = true;
      this.listenForStreamErrors(element);
      this.playBackgroundElement(element);
      return;
    }
    this.playTrack();
  }

  private listenForStreamErrors(element: HTMLAudioElement) {
    if (this.backgroundElement === element) return;
    element.addEventListener("error", () =>
      this.set({
        playing: false,
        error: "The stream didn't play. It may be offline, or not allow other sites.",
      }),
    );
  }

  private playTrack() {
    const { background } = this.state;
    if (background?.kind !== "playlist") return;
    const tracks = background.tracks.filter((id) => this.library.has(id));
    if (tracks.length === 0) {
      this.set({ playing: false, error: "The playlist is empty." });
      return;
    }
    const id = tracks[this.trackIndex % tracks.length] ?? tracks[0] ?? "";
    const file = this.library.get(id);
    if (!file) return;
    // a fresh element per track, so a track used in a cue keeps its own
    const element =
      this.backgroundElement?.src === file.url ? this.backgroundElement : new Audio(file.url);
    element.onended = () => {
      this.trackIndex++;
      this.backgroundElement = null;
      this.playTrack();
    };
    this.set({ track: file.name });
    this.playBackgroundElement(element);
  }

  private playBackgroundElement(element: HTMLAudioElement) {
    this.backgroundElement = element;
    this.live.set(element, 1);
    element.volume = this.elementVolume(element, 1);
    element.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.set({ blocked: true });
        return;
      }
      this.set({
        playing: false,
        error: error instanceof Error ? error.message : "The music didn't play.",
      });
    });
  }

  private pauseBackground() {
    this.generator?.stop();
    this.generator = null;
    this.backgroundElement?.pause();
  }

  stopBackground() {
    this.pauseBackground();
    if (this.backgroundElement) this.live.delete(this.backgroundElement);
    this.backgroundElement = null;
    this.set({ playing: false, track: null });
    // let what's queued ring out under a quick fade instead of cutting it
    const context = this.context;
    if (context && this.musicBus) {
      this.musicBus.gain.setTargetAtTime(0, context.currentTime, 0.15);
      window.setTimeout(() => this.applyLevels(), 800);
    }
  }

  /** Background music steps aside while a music cue plays, then carries on. */
  private duck(on: boolean) {
    if (this.ducked === on) return;
    this.ducked = on;
    if (on) this.pauseBackground();
    this.applyLevels();
    if (!on) this.resumeBackground();
  }

  // ── cues ───────────────────────────────────────────────────────────

  /** The cues to keep time for, worked out from the schedule. */
  setCues(plans: Tuple<PlannedCue>) {
    this.cues = [...plans];
    const current = this.current;
    // a cue that was removed or moved stops; the moved one starts again at its new time
    if (current && !plans.some((plan) => sameTime(plan, current.plan))) this.endCue();
    this.runCues();
  }

  /** Starts what's due, ends what's over, and sleeps until the next of either. */
  private runCues() {
    if (typeof window === "undefined") return;
    if (this.cueTimer !== null) window.clearTimeout(this.cueTimer);
    this.cueTimer = null;
    const now = Date.now();
    if (this.current && now >= this.current.plan.endsAt - 50) this.endCue();
    let next = Infinity;
    for (const plan of this.cues) {
      const key = keyOf(plan);
      if (this.handled.has(key)) {
        if (this.current && sameTime(plan, this.current.plan))
          next = Math.min(next, plan.endsAt - now);
        continue;
      }
      const action = cueAction(plan, now);
      if (action.kind === "done") {
        this.handled.add(key);
        continue;
      }
      if (action.kind === "wait") {
        if (action.inMs <= WARM_MS && plan.cue.sound.kind === "file") this.load(plan.cue.sound.id);
        // wake to warm it up, then again to start it
        next = Math.min(next, action.inMs > WARM_MS ? action.inMs - WARM_MS : action.inMs);
        continue;
      }
      if (this.state.blocked) continue; // starts when the person clicks
      void this.startCue(plan, action.fromMs);
    }
    // a long sleep is checked again regularly, since a hidden tab's timers can run late; a cue
    // that starts late still plays in step, from where everyone else is
    if (next < Infinity) {
      this.cueTimer = window.setTimeout(() => this.runCues(), Math.max(50, Math.min(next, 15_000)));
    }
  }

  private async startCue(plan: PlannedCue, fromMs: number) {
    const key = keyOf(plan);
    this.handled.add(key);
    // played even when muted, at no volume, so unmuting finds it in step
    const music = plan.cue.channel === "music";
    if (this.current && music) this.endCue();
    if (music) this.duck(true);
    const stop = await this.play(plan.cue.sound, plan.cue.channel, plan.cue.volume / 100, {
      fromMs,
    });
    if (!stop) {
      // held back by the browser: try again when the person clicks
      if (this.state.blocked) this.handled.delete(key);
      if (music) this.duck(false);
      return;
    }
    // a streamed song can start a little late; put it back in step with everyone else's
    if (plan.cue.sound.kind === "file") {
      const file = this.library.get(plan.cue.sound.id);
      const element = file && !this.isShort(file) ? this.elements.get(file.id) : undefined;
      if (element) {
        const expected = (Date.now() - plan.startsAt) / 1000;
        if (Math.abs(element.currentTime - expected) * 1000 > DRIFT_MS)
          element.currentTime = expected;
      }
    }
    if (!music) return;
    this.current = { plan, stop };
    this.set({ cue: { label: plan.cue.label, endsAt: plan.endsAt } });
    this.runCues();
  }

  private endCue() {
    this.current?.stop();
    this.current = null;
    this.set({ cue: null });
    this.duck(false);
  }
}

const keyOf = (plan: PlannedCue) => `${plan.cue.id}:${plan.startsAt}`;
const sameTime = (a: PlannedCue, b: PlannedCue) => keyOf(a) === keyOf(b);

export const engine = new Engine();
