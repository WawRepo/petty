import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Play, X } from "lucide-react";

/**
 * The tour film on the landing page (PETTY-329): a button in the hero, and the film over the whole page.
 * Nothing of the film loads before the click — the video has no source until then and preloads nothing.
 * The click opens a modal <dialog> and starts the film with sound: a click is the go-ahead a browser
 * asks for before it plays sound. A tall, narrow screen gets the tall cut, any other the wide one; the
 * thumbnail follows the same rule. Esc, × or a click beside the film closes it, pauses it and gives the
 * focus back to the button. The films come from this Petty's own server (no third party sees who
 * watches); their words are English, which the other languages' button text says.
 */
const WIDE = { src: "/landing/tour/petty-tour.mp4", poster: "/landing/tour/poster.webp" };
const TALL = { src: "/landing/tour/petty-tour-tall.mp4", poster: "/landing/tour/poster-tall.webp" };
const TALL_SCREEN = "(max-aspect-ratio: 4/5)";

export function TourFilm() {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  function open() {
    const d = dialog.current, v = video.current;
    if (!d || !v) return;
    const film = window.matchMedia?.(TALL_SCREEN).matches ? TALL : WIDE;
    if (v.getAttribute("src") !== film.src) { v.poster = film.poster; v.src = film.src; }
    d.classList.toggle("tall", film === TALL);
    document.documentElement.classList.add("tour-open");
    d.showModal();
    // still inside the click, so the browser lets it play with sound; one that refuses leaves the controls
    void v.play()?.catch(() => undefined);
  }
  const close = () => dialog.current?.close();
  function closed() {
    video.current?.pause();
    document.documentElement.classList.remove("tour-open");
    opener.current?.focus();
  }

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- its name is the text in the spans below */}
      <button type="button" ref={opener} className="tour-btn" onClick={open} data-testid="tour-open">
        <span className="tour-thumb">
          <picture>
            <source media={TALL_SCREEN} srcSet={TALL.poster} />
            <img src={WIDE.poster} alt="" width="136" height="76" />
          </picture>
          <span className="tour-play"><Play size={14} fill="currentColor" aria-hidden="true" /></span>
        </span>
        <span className="tour-text">
          <span className="tour-label">{t("landing.tour.button")}</span>
          <span className="tour-meta">{t("landing.tour.meta")}</span>
        </span>
      </button>
      {/* a click beside the film closes it too, for a mouse; Esc and × are the keyboard's and every user's way */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <dialog ref={dialog} className="tour-dialog" aria-label={t("landing.tour.title")} onClose={closed}
        onClick={(e) => { if (e.target === e.currentTarget) close(); }} data-testid="tour-dialog">
        <div className="tour-bar">
          <p className="tour-title">{t("landing.tour.title")} <span className="tour-length">{t("landing.tour.length")}</span></p>
          <button type="button" className="tour-close" aria-label={t("landing.tour.close")} onClick={close} data-testid="tour-close"><X size={20} aria-hidden="true" /></button>
        </div>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- no speech, only music: every word is on screen in the film */}
        <video ref={video} className="tour-video" controls playsInline preload="none" aria-label={t("landing.tour.title")} />
      </dialog>
    </>
  );
}
