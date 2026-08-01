import type { Finding } from "./types";

/**
 * One sentence a non-engineer can act on: what a real person hits because of
 * this finding. The agents write evidence ("504", "loadEventEnd 16073ms",
 * "button-name") — true, checkable, and meaningless to whoever has to decide
 * whether it matters. This maps the evidence to the human consequence.
 *
 * Matched against the TITLE first, and only against title+detail when the
 * title alone matches nothing: details quote foreign text (console errors,
 * cookie names, URLs from other findings), which used to make first-match-wins
 * attach another finding's explanation. No match → empty string, and the UI
 * just shows the technical detail as before.
 */
export function plainImpact(f: Pick<Finding, "agent" | "title" | "detail">): string {
  return match(f.agent, f.title.toLowerCase()) || match(f.agent, `${f.title} ${f.detail}`.toLowerCase());
}

function match(agent: string, t: string): string {
  // Interaction — before the generic console/network patterns, because these
  // findings often QUOTE a console error as their evidence.
  if (/does not search|ignores the query/.test(t)) return "The search box accepts typing but does not actually search — users type, wait, and get the same list. They will assume the data is missing.";
  if (/appears to do nothing/.test(t)) return "Clicking this control produced no visible result. Either it is broken, or it works so invisibly that users cannot tell it worked — both make people click it again and again.";
  if (/\b(media|video|audio)\b/.test(t) && /\b(play|playback|stall)/.test(t)) return "The media on this page does not play properly for the visitor.";

  // Route health
  if (/server error 5\d\d|\b50[234]\b/.test(t)) return "This page is down. Anyone opening it sees an error screen instead of the page — nothing on it can be used until the server is fixed.";
  if (/failed network request/.test(t) && /_rsc=/.test(t)) return "The app pre-loads pages in the background so they open instantly; those background loads are failing. Users still get there, but clicking through feels slow, and it usually means the target pages are broken too.";
  if (/failed network request/.test(t)) return "Parts of this page asked the server for data and got nothing back. Whatever those parts show will be empty, stale, or stuck loading.";
  if (/console error/.test(t)) return "The page logged an error while loading. Users may not see a message, but something on the page did not finish doing its job.";
  if (/no <title>/.test(t)) return "The browser tab for this page has no name, so users with many tabs open cannot tell which one it is. Google and screen readers also use this name.";
  if (/page renders almost no content/.test(t)) return "The page opens but is effectively blank — a user lands on nothing.";

  // Security
  if (/cookie .* weakly configured|not httponly/.test(t)) return "A login-related cookie can be read by scripts on the page. If any script on the site is ever compromised, an attacker can copy it and act as the logged-in user.";
  if (/missing security header|content security policy|hsts/.test(t)) return "A standard browser protection is switched off, which makes other attacks on this site easier than they need to be.";

  // Permissions / data
  if (/idor|other (role|tenant)|cross-role|unauthori[sz]ed/.test(t)) return "A user can reach data that belongs to someone else. This is a privacy breach, not a cosmetic issue.";

  // Accessibility
  if (/button-name|discernible text/.test(t)) return "These buttons are icons with no name attached. A blind user hears only \"button\" and cannot tell what it does — those actions are unusable for them.";
  if (/color-contrast|\bcontrast\b/.test(t)) return "Text is too faint against its background. People with weak eyesight, or anyone on a phone in sunlight, cannot read it.";
  if (/landmark|region\)/.test(t)) return "Screen readers use page sections to let users jump around. These sections are unlabelled or duplicated, so navigating by keyboard is slower and confusing.";
  if (/lang attribute|<html lang/.test(t)) return "The page does not say which language it is in, so screen readers may read Arabic text with an English voice (or the reverse).";
  if (/^a11y|accessib/.test(agent + t)) return "Part of this page is hard or impossible to use for people relying on a screen reader or keyboard.";

  // Performance
  if (/very slow page load/.test(t)) return "This page takes over 9 seconds to finish loading. Most people give up well before that — expect users to leave or assume the site is broken.";
  if (/slow page load|largest contentful paint|\blcp\b/.test(t)) return "The page feels sluggish — several seconds of waiting before it is usable. Users notice this immediately.";
  if (/memory (keeps )?(climbing|leak)/.test(t)) return "The longer someone keeps this app open, the more memory it eats. After a long session the tab slows down or crashes.";

  // Forms & data flows
  if (/create-form submit had no visible effect|silently failed/.test(t)) return "Someone filled in a form, pressed save, and got no confirmation and no visible record. They cannot tell whether their work was saved — most people will submit again and create duplicates.";
  if (/missing both name and id/.test(t)) return "This field is not labelled internally, so browser autofill and password managers skip it — users have to type everything by hand.";
  if (/accepts invalid|no validation|does not validate/.test(t)) return "The form accepts obviously wrong input without complaining, so bad data goes straight into the system.";
  if (/\bundefined\b|\bnan\b|\[object object\]|raw template/.test(t)) return "Placeholder or broken values are showing on the page where real data should be — users see gibberish.";

  // Resilience
  if (/network is offline|images fail|connection is very slow/.test(t)) return "When the connection drops or slows down, this page goes blank instead of saying what happened. Users on poor mobile networks see an empty screen and no explanation.";

  // Layout / visual
  if (/clipped|overflowing text/.test(t)) return "Text is cut off by its box, so part of what was written is simply not readable on screen.";
  if (/visual change detected/.test(t)) return "This page looks different from the last run. It could be a normal content update or an accidental layout break — worth one glance at the screenshot.";

  // SEO
  if (/canonical|meta description|open graph|multiple <h1>|noindex/.test(t)) return "A search-engine detail is missing. No user-facing breakage — it affects how well this page ranks and how it looks when shared.";

  return "";
}
