/*
 * Copyright (c) 2021 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

/// <reference path="../ennuizel.d.ts" />

const licenseInfo = `
Copyright (c) 2021 Yahweasel

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

// extern
declare let LibAV: any;

// The plugin info
const plugin: ennuizel.Plugin = {
    name: "Better Normalization",
    id: "better-normalization",
    infoURL: "https://github.com/ennuizel/ennuizel-better-normalization-plugin",
    description: 'This plugin adds a normalization filter that gives dynaudnorm time to adapt.',
    licenseInfo,
    load,
    api: {
        betterNormalize
    }
};

// Register the plugin
Ennuizel.registerPlugin(plugin);

/**
 * Load the plugin.
 */
async function load() {
    // Register the filter
    Ennuizel.filters.registerCustomFilter({
        name: "_Normalize (Improved)",
        filter: uiNormalize
    });
}

/**
 * User interface.
 * @param d  Dialog to show filter options.
 */
async function uiNormalize(d: ennuizel.ui.Dialog) {
    // Currently no options
    await Ennuizel.ui.loading(async function(d) {
        await betterNormalize(Object.create(null), Ennuizel.select.getSelection(), d);
    }, {
        reuse: d
    });
}

/**
 * Filter implementation.
 * @param opts  dynaudnorm options.
 * @param sel  Selection to filter.
 * @param d  Dialog to show progress.
 */
async function betterNormalize(
    opts: Record<string, string>, sel: ennuizel.select.Selection,
    d: ennuizel.ui.Dialog
) {
    // Get the audio tracks
    let tracks = <ennuizel.track.AudioTrack[]>
        sel.tracks.filter(x => x.type() === Ennuizel.TrackType.Audio);
    tracks = tracks.filter(x => x.duration() !== 0);

    if (tracks.length === 0)
        return;

    if (d)
        d.box.innerHTML = "Filtering...";

    // Make the stream options
    const streamOpts = {
        start: sel.range ? sel.start : void 0,
        end: sel.range ? sel.end : void 0
    };

    // Make the filter string
    let fs = "dynaudnorm";
    if (Object.keys(opts).length) {
        fs += "=";
        const parts: string[] = [];
        for (const key in opts)
            parts.push(key + "=" + opts[key]);
        fs += parts.join(":");
    }
    fs += ",atrim=start=10";

    // Make the status
    const status = tracks.map(x => ({
        name: x.name,
        filtered: 0,
        duration: x.sampleCount()
    }));

    // Function to show the current status
    function showStatus() {
        if (d) {
            const statusStr = status.map(x =>
                x.name + ": " + Math.round(x.filtered / x.duration * 100) + "%")
            .join("<br/>");
            d.box.innerHTML = "Filtering...<br/>" + statusStr;
        }
    }

    // The filtering function for each track
    async function filterThread(track: ennuizel.track.AudioTrack, idx: number) {
        // Make a libav instance
        const libav = await LibAV.LibAV();

        // Make our filter
        const channelLayout = (track.channels === 1) ? 4 : ((1<<track.channels)-1);
        const frame = await libav.av_frame_alloc();
        const [, src, sink] =
            await libav.ff_init_filter_graph(fs, {
                sample_rate: track.sampleRate,
                sample_fmt: track.format,
                channel_layout: channelLayout
            }, {
                sample_rate: track.sampleRate,
                sample_fmt: track.format,
                channel_layout: channelLayout
            });

        // Pre-padding input stream
        let preInStream = track.stream(streamOpts).getReader();

        // Get 10 seconds of data through the filter for normalization
        let remaining = 10 * track.sampleRate * track.channels;
        while (remaining) {
            const rd = await preInStream.read();
            if (rd.done) {
                // Try again from the start
                preInStream = track.stream(streamOpts).getReader();
            } else {
                rd.value.node = null;
                if (rd.value.data.length > remaining)
                    rd.value.data = rd.value.data.subarray(0, remaining);
                await libav.ff_filter_multi(src, sink, frame, [rd.value], false)
                remaining -= rd.value.data.length;
            }
        }
        preInStream.cancel();

        // Input stream
        const inStream = track.stream(Object.assign({keepOpen: true}, streamOpts)).getReader();

        // Filter stream
        const filterStream = new Ennuizel.ReadableStream({
            async pull(controller) {
                while (true) {
                    // Get some data
                    const inp = await inStream.read();
                    if (inp.value)
                        inp.value.node = null;

                    // Filter
                    const outp = await libav.ff_filter_multi(
                        src, sink, frame,
                        inp.done ? [] : [inp.value], inp.done);

                    // Update the status
                    if (inp.done)
                        status[idx].filtered = status[idx].duration;
                    else
                        status[idx].filtered += inp.value.data.length;
                    showStatus();

                    // Write it out
                    for (const part of outp)
                        controller.enqueue(part.data);

                    // Maybe end it
                    if (inp.done)
                        controller.close();

                    if (outp.length || inp.done)
                        break;
                }
            }
        });

        // Overwrite the track
        await track.overwrite(filterStream, Object.assign({closeTwice: true}, streamOpts));

        // And get rid of the libav instance
        libav.terminate();
    }

    // Number of threads to run at once
    const threads = navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;

    // Current state
    const running: Promise<unknown>[] = [];
    const toRun = tracks.map((x, idx) => <[ennuizel.track.AudioTrack, number]> [x, idx]);

    // Run
    while (toRun.length) {
        // Get the right number of threads running
        while (running.length < threads && toRun.length) {
            const [sel, idx] = toRun.shift();
            running.push(filterThread(sel, idx));
        }

        // Wait for one to finish to make room for more
        const fin = await Promise.race(running.map((x, idx) => x.then(() => idx)));
        running.splice(fin, 1);
    }

    // Wait for them all to finish
    await Promise.all(running);
}
