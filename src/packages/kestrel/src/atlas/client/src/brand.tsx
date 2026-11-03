import type { AtlasBrandingOptions } from "../../appearance.js";

/** A single image contract keeps login and navigation branding consistent. */
export function AtlasBrand({ branding, title, login = false }: {
  readonly branding?: AtlasBrandingOptions | undefined;
  readonly title: string;
  readonly login?: boolean;
}) {
  const logo = branding?.logo;
  return <span className={`${login ? "login-brand-mark" : "brand-mark"}${logo ? " has-logo" : ""}`}>
    {logo ? <>
      <img className={logo.darkSrc ? "brand-image-light" : undefined} src={logo.src} alt={logo.alt} />
      {logo.darkSrc ? <img className="brand-image-dark" src={logo.darkSrc} alt={logo.alt} /> : null}
    </> : <span aria-hidden="true">{title.at(0)}</span>}
  </span>;
}
