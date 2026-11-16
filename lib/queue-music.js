function musicSongs(queue) {
  return (queue.songs || []).filter((s) => !s.__systemAnnouncement);
}

function leadingSystemTracks(queue) {
  const prefix = [];
  for (const s of queue.songs || []) {
    if (s.__systemAnnouncement) prefix.push(s);
    else break;
  }
  return prefix;
}

function setMusicSongs(queue, tracks) {
  queue.songs = [...leadingSystemTracks(queue), ...tracks];
}

function invalidateBackgroundResolves(queue) {
  queue._bgResolveToken = (queue._bgResolveToken || 0) + 1;
}

function clearUpcoming(queue) {
  const music = musicSongs(queue);
  if (music.length <= 1) return null;
  const cleared = music.length - 1;
  setMusicSongs(queue, [music[0]]);
  return cleared;
}

module.exports = {
  musicSongs,
  leadingSystemTracks,
  setMusicSongs,
  invalidateBackgroundResolves,
  clearUpcoming
};
