# Sounds

Organizers make an event sound like theirs. Upload a library, choose what plays when something happens
(an announcement, a message, a solved problem), time music to the schedule ("this song ends exactly when
hacking ends"), and pick background music. Built-in sounds cover everything with nothing uploaded.

Participants don't set anything up: sounds just play. Browsers allow no sound until someone has clicked or
typed on the page, so everything starts at that first interaction; a cue held back until then joins in
step with everyone else. Anyone can turn the event's sounds off with the speaker button beside the notifications bell
(saved to their account) or from ⌘K.

Turn it on in Manage → Extensions, where the switches, volumes and background music live, then set it up
in **Manage → Sounds**.

## Library

Upload audio files (MP3, M4A/AAC, OGG/Opus, WebM, WAV, FLAC), up to 25 MB each, or **Link a sound** by
the address of an audio file on another site. A linked sound plays from there: it takes no room and
doesn't count toward the limit, always streams (a page may play another site's audio but not always
fetch it), and stops working if that site takes it down. Platform admins can cap
how much an event holds (Instance → Extensions, or per organization: **Uploaded sound per event**).

- Files up to 20 seconds are fetched and decoded in full the first time they're needed, so an effect
  starts the instant its signal arrives. Longer ones (songs) stream.
- **Preload** fetches a file as soon as someone opens the event. Leave it off for big songs that play
  once: a cue's sound is fetched 90 seconds before it starts anyway.
- Each upload gets a new, never-reused address, so browsers cache it for good.
- Files are served from a public bucket (like pictures on the event home): anyone with the address can
  play them, so don't upload anything private.

## Effects

Each _signal_ (something that just happened in a person's browser) can play a sound: the default, nothing,
a built-in, or an upload. Bogey sends signals for announcements, notifications, and messages and
announcements you send. Challenges sends them for solutions sent, accepted and rejected and flags captured
or wrong. Sounds itself notices messages arriving and windows opening and closing. Any extension can declare
signals (see `signals` in Bogey's `docs/plugins.md`), and they appear here.

Each person hears what happens to them: their own solution being accepted, an announcement they can see.

## Cues

A cue plays one sound for everyone at a time worked out from the schedule:

- **From** the event's start or end, a window opening or closing (its time on the agenda), or a time you pick.
- **Offset** before or after that.
- **Start it** or **Finish it** then. "Finish it at the event's end" starts a three-minute song three
  minutes early, so it ends on the dot.
- **As music** pauses background music while it plays; **over everything** plays like an effect.
- **People who arrive partway through hear the rest**, in step with everyone else. Off, a cue is skipped by
  anyone more than two seconds late.

Times come from the browser's clock, which is usually within a second of real time. A window opened by
hand has no time, so its cues don't play.

A tab that's been hidden for a while may check the schedule only once a minute, but since a late cue
joins in step, a cue that finishes at a time still finishes then.

## Background music

Off unless organizers pick it in Manage → Extensions: songs from the library (the sounds switched to
**In background music** in the library, played in turn), generated lo-fi or ambient music (made in the browser, nothing downloaded), or an https radio
stream. It plays on every page of the event and steps aside while a music cue plays. Someone who turns
sounds off stops it downloading too.

Organizers can add a **Now playing** card to the event home (Customize → Extensions). It shows the cue that's on, or
else the background music. **Let people pause the music**, off by default, adds a play/pause button to it for the
background music in that person's browser; cues can't be paused.

Organizers set the effects and music volumes for everyone.
