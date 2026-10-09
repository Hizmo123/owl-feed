Custom avatars
==============

Every account gets a generated illustrated avatar by default. To give a character
or NPC your own picture, drop an image in this folder named after their handle:

    public/avatars/<handle>.png
    public/avatars/<handle>.jpg   (or .jpeg)
    public/avatars/<handle>.webp

Examples:  hagrid.png   d.malfoy.webp   rita.skeeter.jpg

- The handle is the part after the @ (lowercase). Dots are part of the name.
- Square images work best; 400x400 or larger is plenty.
- The server picks new files up within about 20 seconds, no restart needed, and
  sends the URL to every client as the user's `avatarUrl`.
- A player's own upload (Edit profile) wins over a file in this folder.
- Only use images you have the right to use. Do not use photos of actors or film stills.
