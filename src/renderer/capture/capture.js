// Hidden host-side renderer: captures the screen and streams it to each authorized viewer.
(function () {
  'use strict';

  const bridge = window.capture;
  // Screen content compresses well; these keep text sharp without overloading a software encoder.
  const QUALITY = {
    sharp: { maxBitrate: 10000000, maxFramerate: 30, maxWidth: 0 },
    balanced: { maxBitrate: 5000000, maxFramerate: 30, maxWidth: 1920 },
    saver: { maxBitrate: 1500000, maxFramerate: 15, maxWidth: 1280 },
  };
  const sessions = new Map();

  const report = (message) => bridge.send('error', { message: String(message) });
  const hintFor = (quality) => (quality === 'saver' ? 'motion' : 'detail');

  async function captureScreen(sourceId, width, height, audio) {
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: 30,
      },
    };
    if (audio) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video });
      } catch (err) {
        report(`sound unavailable: ${err.message}`);
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }

  // getParameters/setParameters must not interleave, so quality changes run one at a time per session.
  function applyQuality(session) {
    session.qualityChain = (session.qualityChain || Promise.resolve()).then(async () => {
      if (!session.videoSender || !sessions.has(session.sid)) return;
      const q = QUALITY[session.quality] || QUALITY.balanced;
      const scale = q.maxWidth && session.width > q.maxWidth ? session.width / q.maxWidth : 1;
      const build = (withPreference) => {
        const params = session.videoSender.getParameters();
        if (!params.encodings || !params.encodings.length) return null;
        Object.assign(params.encodings[0], { maxBitrate: q.maxBitrate, maxFramerate: q.maxFramerate, scaleResolutionDownBy: scale });
        // Desktop text must stay sharp: lower the frame rate before lowering resolution (except in Data saver).
        // Without an explicit preference the track's contentHint decides, so never echo back a default.
        if (withPreference) params.degradationPreference = session.quality === 'saver' ? 'maintain-framerate' : 'maintain-resolution';
        else delete params.degradationPreference;
        return params;
      };
      try {
        const params = build(true);
        if (params) await session.videoSender.setParameters(params);
        if (!session.reportedMode) report(`quality mode: ${session.quality}, preference applied`);
      } catch (first) {
        try {
          const params = build(false);
          if (params) await session.videoSender.setParameters(params);
          if (!session.reportedMode) report(`quality mode: ${session.quality}, preference rejected (${first.message}); using contentHint`);
        } catch (err) {
          report(`quality: ${err.message}`);
        }
      }
      session.reportedMode = true;
    });
    return session.qualityChain;
  }

  function stopStream(stream) {
    if (stream) for (const track of stream.getTracks()) track.stop();
  }

  function end(sid, reason) {
    const session = sessions.get(sid);
    if (!session) return;
    sessions.delete(sid);
    try { session.pc.close(); } catch { /* closed */ }
    stopStream(session.stream);
    if (reason) bridge.send('ended', { sid, reason });
  }

  bridge.on('start', async ({ sid, sourceId, width, height, quality, audio, iceServers }) => {
    const pc = new RTCPeerConnection({ iceServers: Array.isArray(iceServers) ? iceServers : [], bundlePolicy: 'max-bundle' });
    const session = { sid, pc, stream: null, videoSender: null, width, height, quality, remoteSet: false, pendingIce: [] };
    sessions.set(sid, session);

    pc.onicecandidate = (e) => { if (e.candidate) bridge.send('ice', { sid, candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') end(sid, 'failed');
      if (pc.connectionState === 'connected') applyQuality(session);
    };
    const channel = pc.createDataChannel('input', { ordered: true });
    channel.onmessage = (e) => {
      if (typeof e.data === 'string' && e.data.length < 4096) bridge.send('input', { sid, data: e.data });
    };

    try {
      session.stream = await captureScreen(sourceId, width, height, audio);
      if (!sessions.has(sid)) {
        stopStream(session.stream);
        return;
      }
      const [video] = session.stream.getVideoTracks();
      video.contentHint = hintFor(quality);
      session.videoSender = pc.addTrack(video, session.stream);
      for (const track of session.stream.getAudioTracks()) pc.addTrack(track, session.stream);
      await pc.setLocalDescription(await pc.createOffer());
      bridge.send('offer', { sid, sdp: pc.localDescription.sdp });
    } catch (err) {
      report(err.message);
      end(sid, 'capture-failed');
    }
  });

  bridge.on('signal', async ({ sid, type, sdp, candidate }) => {
    const session = sessions.get(sid);
    if (!session) return;
    try {
      if (type === 'answer') {
        await session.pc.setRemoteDescription({ type: 'answer', sdp });
        session.remoteSet = true;
        for (const c of session.pendingIce.splice(0)) await session.pc.addIceCandidate(c).catch(() => {});
        applyQuality(session);
      } else if (type === 'ice') {
        if (session.remoteSet) await session.pc.addIceCandidate(candidate);
        else session.pendingIce.push(candidate);
      }
    } catch (err) {
      report(`signal: ${err.message}`);
    }
  });

  bridge.on('display', async ({ sid, sourceId, width, height }) => {
    const session = sessions.get(sid);
    if (!session || !session.videoSender) return;
    try {
      const stream = await captureScreen(sourceId, width, height, false);
      const [video] = stream.getVideoTracks();
      video.contentHint = hintFor(session.quality);
      await session.videoSender.replaceTrack(video);
      for (const track of session.stream.getVideoTracks()) track.stop();
      session.stream = new MediaStream([video, ...session.stream.getAudioTracks()]);
      session.width = width;
      session.height = height;
      applyQuality(session);
    } catch (err) {
      report(`display: ${err.message}`);
    }
  });

  bridge.on('quality', ({ sid, quality }) => {
    const session = sessions.get(sid);
    if (!session) return;
    session.quality = quality;
    const [video] = session.stream ? session.stream.getVideoTracks() : [];
    if (video) video.contentHint = hintFor(quality);
    applyQuality(session);
  });

  bridge.on('stop', ({ sid }) => end(sid));

  bridge.send('ready', {});
})();
