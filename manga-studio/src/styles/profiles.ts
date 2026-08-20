import type { ProjectDocument, StyleFamilyId, StyleProfile, StyleVisualProperties } from "@/domain/types";

export const DEFAULT_STYLE_PROFILE_ID = "japanese-manga/minimal-line-manga";

export const STYLE_FAMILIES: { id: StyleFamilyId; name: string; description: string }[] = [
  { id: "japanese-manga", name: "Japanese Manga", description: "Ink, screentone, and expressive sequential-art traditions." },
  { id: "chinese-manhua", name: "Chinese Manhua", description: "Graphic storytelling from contemporary polish to ink-wash atmosphere." },
  { id: "western-comics", name: "Western Comics", description: "Bold graphic silhouettes, cartoon economy, and print-inspired rendering." },
  { id: "webtoon", name: "Webtoon", description: "Clean digital rendering designed for readable vertical storytelling." },
  { id: "sketch-experimental", name: "Sketch & Experimental", description: "Loose, handmade, minimal, and pre-production visual languages." },
  { id: "custom", name: "Custom", description: "Your own reusable visual direction and optional reference image." },
];

const FAMILY_BASE: Record<Exclude<StyleFamilyId, "custom">, string> = {
  "japanese-manga": "Japanese sequential-art illustration, deliberate ink drawing, clear panel readability",
  "chinese-manhua": "Chinese graphic-narrative illustration, elegant silhouettes, expressive environmental design",
  "western-comics": "Western sequential-art illustration, strong graphic composition, readable silhouettes",
  webtoon: "polished digital webtoon illustration, clean mobile-readable shapes, controlled color design",
  "sketch-experimental": "hand-drawn experimental sequential-art image, expressive mark making, immediate visual storytelling",
};

const FAMILY_NEGATIVE: Record<Exclude<StyleFamilyId, "custom">, string> = {
  "japanese-manga": "photorealism, 3D render, painterly concept art, western superhero anatomy, illegible line clutter",
  "chinese-manhua": "photorealism, generic anime screenshot, 3D render, muddy silhouettes, accidental text",
  "western-comics": "photorealism, detailed anime rendering, generic manga screentones, 3D render, muddy anatomy",
  webtoon: "photorealism, traditional screentone page, rough scanned ink, 3D render, noisy crosshatching",
  "sketch-experimental": "photorealism, glossy 3D render, over-polished digital painting, excessive surface detail",
};

function profile(
  family: Exclude<StyleFamilyId, "custom">,
  slug: string,
  name: string,
  description: string,
  positive: string,
  negative: string,
  visualProperties: StyleVisualProperties,
): StyleProfile {
  return {
    id: `${family}/${slug}`,
    family,
    name,
    description,
    positivePrompt: `${FAMILY_BASE[family]}, ${positive}`,
    negativePrompt: `${FAMILY_NEGATIVE[family]}, ${negative}`,
    visualProperties,
  };
}

const MONO = { colorMode: "black-and-white" };
const COLOR = { colorMode: "controlled color" };

export const BUILTIN_STYLE_PROFILES: StyleProfile[] = [
  profile("japanese-manga", "shonen", "Shonen", "Energetic action, bold contours, and highly readable emotion.", "bold varied ink contours, dynamic foreshortening, energetic action shapes, crisp screentone shadows, expressive faces", "delicate fashion-illustration anatomy, muted action, soft painterly edges", { ...MONO, lineStyle: "bold varied ink", detailLevel: "medium-high", shading: "crisp screentone", rendering: "dynamic" }),
  profile("japanese-manga", "shojo", "Shojo", "Elegant figures, delicate lines, luminous emotion, and decorative atmosphere.", "fine graceful linework, elegant elongated proportions, luminous eyes, restrained floral accents, airy negative space, soft screentone gradients", "heavy muscular anatomy, harsh block shadows, cluttered mechanical detail", { ...MONO, lineStyle: "fine graceful ink", detailLevel: "medium", shading: "soft screentone", rendering: "airy" }),
  profile("japanese-manga", "seinen", "Seinen", "Grounded anatomy, mature acting, and cinematic ink contrast.", "grounded adult proportions, subtle facial acting, precise environmental detail, cinematic framing, controlled crosshatching and deep ink shadows", "cute childlike proportions, oversized sparkling eyes, slapstick simplification", { ...MONO, lineStyle: "controlled realistic ink", detailLevel: "high", shading: "crosshatch and ink", rendering: "cinematic" }),
  profile("japanese-manga", "moe", "Moe", "Soft, friendly character shapes with gentle expressions and clean finish.", "soft rounded character design, compact proportions, warm restrained expressions, clean thin contours, simple readable clothing folds, light screentone", "hyper-real anatomy, horror distortion, heavy noir shadows, aggressive crosshatching", { ...MONO, lineStyle: "soft clean ink", detailLevel: "medium-low", shading: "light screentone", rendering: "gentle" }),
  profile("japanese-manga", "chibi", "Chibi", "Tiny bodies, oversized heads, and instantly readable comic emotion.", "super-deformed proportions, oversized head, tiny simplified body, iconic silhouette, extremely readable expression, minimal clothing detail", "realistic adult proportions, subtle facial emotion, complex anatomy, dense texture", { ...MONO, lineStyle: "rounded icon ink", detailLevel: "low", shading: "minimal", rendering: "super-deformed" }),
  profile("japanese-manga", "4-koma", "4-Koma", "Compact gag-strip clarity with consistent, economical drawings.", "compact four-panel gag-comic rendering, stable camera, simplified anatomy, economical clean lines, flat readable staging, crisp reaction faces", "cinematic wide-angle distortion, elaborate backgrounds, painterly lighting, excessive detail", { ...MONO, lineStyle: "economical clean ink", detailLevel: "low-medium", shading: "minimal screentone", rendering: "strip clarity" }),
  profile("japanese-manga", "minimal-line-manga", "Minimal Line Manga", "Few confident lines, simplified anatomy, and strong negative space.", "minimal black-and-white manga drawing, very few confident ink lines, simplified anatomy, restrained facial features, flat composition, iconic readable silhouette, abundant negative space", "large ornate anime eyes, complex hair strands, dense screentones, elaborate cinematic shading, over-rendered anatomy", { ...MONO, lineStyle: "few confident lines", detailLevel: "minimal", shading: "almost none", rendering: "flat iconic" }),
  profile("japanese-manga", "horror-manga", "Horror Manga", "Unsettling ink texture, distorted shadows, and oppressive framing.", "uneasy precise linework, distorted but intentional anatomy, dense black shadow shapes, stippled texture, claustrophobic framing, uncanny facial restraint", "cheerful pastel mood, cute rounded simplification, glossy glamour lighting", { ...MONO, lineStyle: "nervous precise ink", detailLevel: "high", shading: "dense blacks and stipple", rendering: "uncanny" }),
  profile("japanese-manga", "ink-heavy-manga", "Ink-heavy Manga", "Graphic black masses, brush energy, and dramatic chiaroscuro.", "large expressive brush shapes, heavy black fills, dry-brush edges, dramatic chiaroscuro, powerful silhouette-first composition", "thin delicate outlines, pastel color, evenly lit digital rendering, weak contrast", { ...MONO, lineStyle: "heavy brush ink", detailLevel: "medium", shading: "solid black masses", rendering: "high contrast" }),

  profile("chinese-manhua", "modern-manhua", "Modern Manhua", "Polished contemporary characters with clean color and dramatic lighting.", "polished contemporary character rendering, sleek linework, fashionable silhouettes, controlled saturated accents, crisp digital lighting", "vintage newsprint, rough pencil construction, monochrome screentone", { ...COLOR, lineStyle: "sleek digital line", detailLevel: "high", shading: "clean digital", rendering: "polished" }),
  profile("chinese-manhua", "ancient-chinese", "Ancient Chinese", "Elegant historical costume, architecture, and lyrical composition.", "historically inspired layered robes, elegant fabric rhythm, refined hair ornaments, classical architecture, lyrical misty depth, restrained jewel colors", "modern streetwear, science-fiction props, generic Japanese school uniform", { ...COLOR, lineStyle: "refined flowing line", detailLevel: "high", shading: "soft atmospheric", rendering: "historical lyrical" }),
  profile("chinese-manhua", "wuxia", "Wuxia", "Grounded martial movement, flowing robes, and kinetic ink accents.", "graceful martial-arts motion, believable weapon handling, wind-swept layered robes, sharp directional composition, energetic ink accents", "static fashion pose, bulky superhero anatomy, magical particle overload", { ...COLOR, lineStyle: "directional brush line", detailLevel: "high", shading: "ink accents", rendering: "kinetic" }),
  profile("chinese-manhua", "xianxia", "Xianxia", "Ethereal cultivation fantasy with luminous scale and ornate costume.", "ethereal cultivation fantasy, weightless robe movement, celestial architecture, luminous spiritual effects, ornate but readable costume, vast atmospheric scale", "mundane office setting, flat gag-comic staging, muddy effects, modern technology", { ...COLOR, lineStyle: "elegant luminous line", detailLevel: "high", shading: "glowing atmospheric", rendering: "epic fantasy" }),
  profile("chinese-manhua", "cute-manhua", "Cute Manhua", "Rounded shapes, bright expressions, and approachable color design.", "rounded friendly proportions, bright readable expressions, clean compact linework, soft candy-colored accents, simplified environments", "gritty realism, dense black horror texture, severe adult anatomy", { ...COLOR, lineStyle: "rounded clean line", detailLevel: "medium-low", shading: "soft flat", rendering: "cute" }),
  profile("chinese-manhua", "ink-wash", "Ink Wash", "Expressive brush, paper space, and tonal washes inspired by ink painting.", "expressive calligraphic brushwork, diluted ink washes, paper texture, poetic negative space, mist-softened depth, restrained mineral-color accents", "hard vector outlines, glossy 3D lighting, dense digital texture, neon palette", { colorMode: "ink monochrome", lineStyle: "calligraphic brush", detailLevel: "selective", shading: "tonal wash", rendering: "poetic" }),
  profile("chinese-manhua", "minimal-manhua", "Minimal Manhua", "Elegant simplified forms and sparse, controlled color.", "minimal elegant contours, simplified anatomy, sparse environment marks, restrained two-tone palette, calm composition, clear emotional gesture", "ornate costume clutter, dense rendering, photoreal skin, noisy background", { ...COLOR, lineStyle: "elegant sparse line", detailLevel: "minimal", shading: "flat restrained", rendering: "calm" }),

  profile("western-comics", "superhero-comic", "Superhero Comic", "Bold anatomy, graphic shadows, and explosive action readability.", "heroic anatomical construction, bold contour hierarchy, dramatic foreshortening, graphic shadow shapes, explosive action staging, saturated spot colors", "fragile fashion proportions, soft anime screentone, static composition", { ...COLOR, lineStyle: "bold contour", detailLevel: "high", shading: "graphic shadow", rendering: "heroic" }),
  profile("western-comics", "indie-comic", "Indie Comic", "Personal linework, grounded acting, and authored print texture.", "distinctive hand-inked line, grounded imperfect anatomy, nuanced acting, limited print palette, tactile paper and ink texture, intimate framing", "corporate mascot polish, glossy 3D render, generic anime face", { colorMode: "limited print color", lineStyle: "authored hand ink", detailLevel: "medium", shading: "print texture", rendering: "intimate" }),
  profile("western-comics", "cartoon", "Cartoon", "Elastic shapes, clear acting, and colorful graphic simplicity.", "elastic simplified anatomy, strong line of action, bold rounded shapes, readable squash-and-stretch acting, flat color blocks, clean silhouettes", "realistic anatomy, dense crosshatching, subtle unreadable expressions", { ...COLOR, lineStyle: "bold rounded line", detailLevel: "low-medium", shading: "flat", rendering: "elastic" }),
  profile("western-comics", "newspaper-comic", "Newspaper Comic", "Economical strip drawing with compact staging and restrained tone.", "black-and-white newspaper strip illustration, economical confident lines, compact panel staging, simple rounded anatomy, restrained expressions, sparse spot blacks", "detailed anime hair, cinematic rendering, gradients, elaborate backgrounds", { ...MONO, lineStyle: "economical strip ink", detailLevel: "low", shading: "spot black", rendering: "compact" }),
  profile("western-comics", "minimal-line-comic", "Minimal Line Comic", "Iconic comic-strip forms made from very few confident lines.", "minimalist black-and-white comic-strip illustration, very few clean confident ink lines, simple rounded shapes, highly simplified anatomy, restrained facial features, flat composition, minimal shading, iconic readable silhouette", "detailed anime rendering, large anime eyes, complex manga hair strands, screentones, photorealism, complex cinematic shading, over-rendered anatomy", { ...MONO, lineStyle: "few clean lines", detailLevel: "minimal", shading: "none", rendering: "iconic flat" }),
  profile("western-comics", "retro-comic", "Retro Comic", "Vintage print dots, limited inks, and mid-century graphic energy.", "vintage offset-print comic aesthetic, thick contour ink, limited primary palette, visible halftone dots, slight registration character, mid-century graphic composition", "modern glossy gradients, photoreal lighting, clean vector perfection, anime screentone", { colorMode: "limited retro print", lineStyle: "thick vintage ink", detailLevel: "medium", shading: "halftone", rendering: "offset print" }),

  profile("webtoon", "korean-romance", "Korean Romance", "Elegant characters, luminous skin tones, and emotionally focused framing.", "elegant contemporary character proportions, refined clean linework, luminous soft color, fashion detail, expressive close-up acting, romantic atmospheric light", "heavy black ink, rough crosshatching, chibi gag distortion, muddy palette", { ...COLOR, lineStyle: "refined clean line", detailLevel: "high", shading: "soft luminous", rendering: "romantic" }),
  profile("webtoon", "korean-action", "Korean Action", "Sharp digital linework, dramatic camera angles, and high-impact effects.", "sharp precise digital linework, athletic anatomy, dramatic perspective, high-contrast color lighting, readable impact effects, kinetic vertical composition", "static flat staging, delicate low-contrast line, vintage paper texture", { ...COLOR, lineStyle: "sharp digital line", detailLevel: "high", shading: "high-contrast digital", rendering: "kinetic" }),
  profile("webtoon", "fantasy-webtoon", "Fantasy Webtoon", "Polished fantasy costume, magic effects, and atmospheric depth.", "polished fantasy character rendering, ornate readable costume, luminous magic effects, deep atmospheric backgrounds, jewel-tone palette, clean vertical storytelling", "mundane flat lighting, monochrome newspaper ink, cluttered illegible ornament", { ...COLOR, lineStyle: "polished fantasy line", detailLevel: "high", shading: "luminous", rendering: "fantasy" }),
  profile("webtoon", "cute-webtoon", "Cute Webtoon", "Soft shapes, friendly acting, and warm pastel color.", "soft rounded anatomy, warm friendly expressions, clean compact outlines, pastel flat colors, simple cozy environments, sticker-like readability", "grim horror texture, realistic pores, aggressive black shadow, complex anatomy", { colorMode: "pastel color", lineStyle: "soft compact line", detailLevel: "medium-low", shading: "soft flat", rendering: "cozy" }),
  profile("webtoon", "modern-flat-webtoon", "Modern Flat Webtoon", "Crisp geometry, flat color, and efficient everyday storytelling.", "clean geometric forms, crisp uniform linework, modern flat color blocks, simplified lighting, contemporary wardrobe, highly readable mobile composition", "painterly brushwork, crosshatching, vintage halftone, excessive texture", { ...COLOR, lineStyle: "crisp uniform line", detailLevel: "medium", shading: "flat geometric", rendering: "modern" }),

  profile("sketch-experimental", "pencil-sketch", "Pencil Sketch", "Layered graphite construction with controlled finish and paper texture.", "visible graphite line variation, selective construction marks, soft smudged value, white paper texture, observational gesture, controlled unfinished edges", "inked vector contour, glossy digital color, perfect mechanical edges", { ...MONO, lineStyle: "graphite", detailLevel: "medium", shading: "pencil value", rendering: "observational" }),
  profile("sketch-experimental", "rough-ink", "Rough Ink", "Fast brush marks, broken edges, and energetic black-and-white rhythm.", "fast gestural brush ink, broken dry-brush edges, decisive spot blacks, visible hand pressure, energetic imperfect anatomy, raw page texture", "smooth vector line, airbrushed gradients, polished 3D surface", { ...MONO, lineStyle: "rough brush ink", detailLevel: "medium", shading: "spot black", rendering: "raw" }),
  profile("sketch-experimental", "doodle", "Doodle", "Playful spontaneous marks and charmingly simple forms.", "casual spontaneous pen doodle, playful uneven contours, simplified whimsical anatomy, small symbolic details, open white space, notebook immediacy", "formal realism, cinematic lighting, complex perspective, dense polished rendering", { ...MONO, lineStyle: "casual pen", detailLevel: "low", shading: "scribble accents", rendering: "playful" }),
  profile("sketch-experimental", "minimalist", "Minimalist", "Essential shapes, deliberate emptiness, and near-zero rendering.", "extreme visual reduction, essential contour fragments, geometric silhouette, deliberate negative space, one or two tonal accents, calm balanced composition", "ornament, dense texture, photorealism, elaborate shading, clutter", { colorMode: "near-monochrome", lineStyle: "essential marks", detailLevel: "minimal", shading: "near-zero", rendering: "reductive" }),
  profile("sketch-experimental", "storyboard", "Storyboard", "Production-ready staging, readable action, and value-block clarity.", "storyboard frame drawing, clear camera staging, readable action arrows implied through gesture, simple value blocks, loose construction, continuity-first composition", "finished illustration polish, decorative detail, elaborate surface rendering, poster composition", { ...MONO, lineStyle: "loose production line", detailLevel: "low-medium", shading: "value blocks", rendering: "staging-first" }),
];

const BUILTIN_BY_ID = new Map(BUILTIN_STYLE_PROFILES.map((item) => [item.id, item]));

export function getStyleProfile(doc: ProjectDocument, styleId: string): StyleProfile | undefined {
  return doc.project.settings.artStyle.customProfiles[styleId] ?? BUILTIN_BY_ID.get(styleId);
}

export function getActiveStyleProfile(doc: ProjectDocument): StyleProfile {
  return getStyleProfile(doc, doc.project.settings.artStyle.activeStyleId) ?? BUILTIN_BY_ID.get(DEFAULT_STYLE_PROFILE_ID)!;
}

export function styleProfilesForFamily(family: StyleFamilyId): StyleProfile[] {
  return BUILTIN_STYLE_PROFILES.filter((item) => item.family === family);
}
