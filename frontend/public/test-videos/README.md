# Prototype evidence test videos

This folder is read by the "Prototype Video Evidence" page
(`/prototype-video`) as a stand-in camera source when a physical webcam
isn't available. It is **empty by default** -- no fake video files are
checked in.

To use the feature, place three real, playable video files here with
these exact names:

```
frontend/public/test-videos/aug-11.mp4
frontend/public/test-videos/aug-10.mp4
frontend/public/test-videos/aug-09.mp4
```

Any real MP4 (or other browser-playable format) works -- a short phone
recording, a webcam test clip, anything genuine. The app detects each
file's presence with an HTTP HEAD request at load time; a card is only
marked `READY` if the file actually exists and responds. Missing files
are shown honestly as `NOT FOUND`, never silently skipped or faked.

All duration, resolution, file size, SHA-256, segment count, and root
hash values shown in the UI are computed for real from whatever file you
place here -- nothing is hardcoded.
