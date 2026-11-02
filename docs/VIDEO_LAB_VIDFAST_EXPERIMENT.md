# VidFast Vizio compatibility checkpoint

VidFast's [official embed documentation](https://vidfast.vc/) lists `autoPlay=true` for movie and TV URLs. It also lists a `server` parameter but supplies no player server names; the site's `Proxy-01` infrastructure labels are not documented player server values. This experiment tests only explicit autoplay. It does not send a Play command or interact with advertisements.

## Physical test matrix

Use the same authorized TMDB movie ID in both rows. Open Video Lab Diagnostics on VidFast, press Down to **Try autoPlay=true**, Right to **Reset VidFast default**, and OK to apply. Each choice reloads the iframe. Record iframe load/error, MEDIA_DATA, provider status, any player play event, actual moving video and audio, and any top-level navigation or pop-ups. Stop/Unload remains available after closing Diagnostics.

| Row | VidFast iframe URL | Outcome that matters |
| --- | --- | --- |
| Baseline | `https://vidfast.vc/movie/{id}` | Reproduce status 500 and no picture without interacting with native controls. |
| Explicit autoplay | `https://vidfast.vc/movie/{id}?autoPlay=true` | Determine whether the documented setting yields actual picture/audio; a sent command, iframe load, or MEDIA_DATA is insufficient. |
| Reset | Original URL again | Check whether any difference is repeatable and specific to the setting. |

For TV the corresponding explicit URL is `https://vidfast.vc/tv/{id}/{season}/{episode}?autoPlay=true`. Keep the same title and network conditions. Stop immediately if the iframe causes unexpected top-level navigation or repeated pop-ups. Do not click ads or use their redirects as part of a playback procedure.

VidFast's reported stream status 500 is a separate provider failure. A later `play` message does not clear its warning without physical confirmation. The Mac's approximately ten redirects/pop-ups might be advertising, navigation, or a provider prerequisite; the available evidence cannot distinguish them. Manual clicking followed by playback does not establish causation. If explicit autoplay still produces status 500 or more redirects, shelve VidFast and compare another provider rather than escalating to ad interaction or stream extraction.
