import { describe, expect, it } from "vitest";
import { clip, decodeEntities, htmlToText, listItems, metaContent, scanTags, tagWithId } from "./html";
import { MAX_IMPORT_IMAGES, isAmazonBlockPage, parseAmazonPage, parseOpenGraph, parseShopifyProduct } from "./parsers";
import { sellerNotesFrom } from "./types";

const shopBase = new URL("https://shop.example.com/products/mug.json");
const amazonBase = new URL("https://www.amazon.com/dp/B07FZ8S74R");

/** The shape GET /products/<handle>.json returned on 2026-09-28
 * (docs/verification.md), trimmed to the fields the parser reads plus a
 * few it must ignore. */
const SHOPIFY_JSON = {
  product: {
    id: 4870548979792,
    title: "Ceramic Pour Over Mug &amp; Lid",
    body_html:
      "<p>Hand glazed stoneware.</p><ul><li>Holds 350 ml</li><li>Dishwasher <b>safe</b></li></ul><script>alert(1)</script>",
    vendor: "Example",
    handle: "mug",
    variants: [{ id: 1, price: "24.00", sku: "MUG-1" }],
    images: [
      {
        id: 2,
        position: 2,
        src: "https://cdn.shopify.com/s/files/1/0001/files/mug-back.png?v=2",
        width: 1600,
        height: 1600,
        alt: null,
      },
      {
        id: 1,
        position: 1,
        src: "//cdn.shopify.com/s/files/1/0001/files/mug-front.png?v=1",
        width: 2048,
        height: 2048,
        alt: "Mug front",
      },
      { id: 3, position: 3, src: "http://insecure.example.com/mug.png" },
      { id: 4, position: 4, src: "javascript:alert(1)" },
    ],
    image: {
      id: 1,
      position: 1,
      src: "//cdn.shopify.com/s/files/1/0001/files/mug-front.png?v=1",
      width: 2048,
      height: 2048,
    },
  },
};

const AMAZON_HTML = `<!doctype html><html><head>
<meta name="title" content="Amazon.com: Echo Dot : Everything Else">
<title>Amazon.com: Echo Dot</title></head><body>
<span id="productTitle" class="a-size-large product-title-word-break">        Echo Dot (3rd Gen) &ndash; Charcoal       </span>
<div id="feature-bullets" class="a-section">
 <ul class="a-unordered-list a-vertical">
  <li id="replacementPartsFitmentBullet"><span class="a-list-item">Make sure this fits by entering your model number.</span></li>
  <li class="a-spacing-mini"><span class="a-list-item"> MEET ECHO DOT &amp; friends.  </span></li>
  <li class="a-spacing-mini"><span class="a-list-item"> RICH AND LOUD SOUND.</span></li>
 </ul>
</div>
<div id="productDescription" class="a-section"><p><span>Our most compact smart speaker.</span></p></div>
<img alt="Echo Dot" id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/landing._AC_SL1000_.jpg" data-a-dynamic-image="{&quot;https://m.media-amazon.com/images/I/landing._AC_SX342_.jpg&quot;:[342,342],&quot;https://m.media-amazon.com/images/I/landing._AC_SX679_.jpg&quot;:[679,679]}">
<script>
P.when('A').register("ImageBlockATF", function(A){
var data = {
'colorImages': { 'initial': A.$.parseJSON('[{"hiRes":"https://m.media-amazon.com/images/I/one._AC_SL1000_.jpg","thumb":"https://m.media-amazon.com/images/I/one._AC_US40_.jpg","large":"https://m.media-amazon.com/images/I/one._AC_.jpg","main":{"https://m.media-amazon.com/images/I/one._AC_SY355_.jpg":[355,355]}},{"hiRes":null,"thumb":"https://m.media-amazon.com/images/I/two._AC_US40_.jpg","large":"https://m.media-amazon.com/images/I/two._AC_.jpg","main":{"https://m.media-amazon.com/images/I/two._AC_SY355_.jpg":[355,355]}}]')},
'colorToAsin': {'initial': {}},
};
});
</script>
</body></html>`;

const AMAZON_CAPTCHA = `<html><body><h4>Enter the characters you see below</h4>
<form method="get" action="/errors/validateCaptcha" name=""></form></body></html>`;

describe("html helpers", () => {
  it("decodes named, decimal and hex entities and drops invalid code points", () => {
    expect(decodeEntities("Tom &amp; Jerry &#8217;s &#x2122; &bogus; &#0; &#xD800;")).toBe("Tom & Jerry ’s ™ &bogus;  ");
  });

  it("turns markup into visible text, dropping scripts and styles", () => {
    expect(htmlToText("<p>One<br>Two</p><style>p{}</style><script>var x = '<p>';</script><div>Three &lt;b&gt;</div>")).toBe(
      "One\nTwo\nThree <b>",
    );
    expect(htmlToText("5 < 6 and <b>bold</b>")).toBe("5 < 6 and bold");
  });

  it("reads list items, meta tags and elements by id", () => {
    expect(listItems("<ul><li>A</li><li> <i>B</i> </li><li></li></ul>")).toEqual(["A", "B"]);
    const html = `<meta content="Mug" property="og:title"><meta name="description" content='Nice mug'>`;
    expect(metaContent(html, "og:title")).toBe("Mug");
    expect(metaContent(html, "description")).toBe("Nice mug");
    expect(metaContent(html, "og:image")).toBeNull();
    expect(tagWithId(`<div><span class="x" id="productTitle">T</span>`, "productTitle")?.name).toBe("span");
  });

  it("clips at a word break", () => {
    expect(clip("one two three four", 16)).toBe("one two three");
    // No break near the end: a hard cut instead of losing most of the text.
    expect(clip("one twothreefour", 12)).toBe("one twothree");
    expect(clip("short", 12)).toBe("short");
  });

  it("stays linear on hostile markup", () => {
    const hostile = [
      "<meta".repeat(200_000),
      "<".repeat(500_000) + ">",
      "<script>".repeat(100_000),
      "<li>".repeat(200_000),
      '<a id="productTitle"'.repeat(50_000),
    ];
    const started = Date.now();
    for (const html of hostile) {
      metaContent(html, "og:image");
      htmlToText(html.slice(0, 200_000));
      listItems(html.slice(0, 200_000));
      tagWithId(html, "productTitle");
      expect([...scanTags(html)].length).toBeGreaterThanOrEqual(0);
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("parseShopifyProduct", () => {
  it("reads the title, text, bullets and https photos in position order", () => {
    const parsed = parseShopifyProduct(SHOPIFY_JSON, shopBase);
    expect(parsed).not.toBeNull();
    expect(parsed?.title).toBe("Ceramic Pour Over Mug & Lid");
    expect(parsed?.description).toBe("Hand glazed stoneware.\nHolds 350 ml\nDishwasher safe");
    expect(parsed?.bullets).toEqual(["Holds 350 ml", "Dishwasher safe"]);
    expect(parsed?.images).toEqual([
      {
        url: "https://cdn.shopify.com/s/files/1/0001/files/mug-front.png?v=1",
        width: 2048,
        height: 2048,
        alt: "Mug front",
      },
      { url: "https://cdn.shopify.com/s/files/1/0001/files/mug-back.png?v=2", width: 1600, height: 1600 },
    ]);
  });

  it("returns null for anything that is not the product JSON", () => {
    expect(parseShopifyProduct(null, shopBase)).toBeNull();
    expect(parseShopifyProduct({ products: [] }, shopBase)).toBeNull();
    expect(parseShopifyProduct({ product: { title: 5 } }, shopBase)).toBeNull();
  });

  it("offers at most the photo cap", () => {
    const many = {
      product: {
        title: "Many",
        images: Array.from({ length: 40 }, (_, i) => ({ src: `https://cdn.shopify.com/${i}.png`, position: i })),
      },
    };
    expect(parseShopifyProduct(many, shopBase)?.images).toHaveLength(MAX_IMPORT_IMAGES);
  });
});

describe("parseAmazonPage", () => {
  it("reads the title, bullets, description and gallery photos", () => {
    const parsed = parseAmazonPage(AMAZON_HTML, amazonBase);
    expect(parsed.title).toBe("Echo Dot (3rd Gen) – Charcoal");
    expect(parsed.bullets).toEqual(["MEET ECHO DOT & friends.", "RICH AND LOUD SOUND."]);
    expect(parsed.description).toBe("Our most compact smart speaker.");
    expect(parsed.images.map((i) => i.url)).toEqual([
      "https://m.media-amazon.com/images/I/one._AC_SL1000_.jpg",
      "https://m.media-amazon.com/images/I/two._AC_.jpg",
      "https://m.media-amazon.com/images/I/landing._AC_SL1000_.jpg",
      "https://m.media-amazon.com/images/I/landing._AC_SX679_.jpg",
    ]);
  });

  it("falls back to the meta title and the landing image alone", () => {
    const html = `<meta name="title" content="Amazon.com: Blue Kettle : Home"><img id="landingImage" data-a-dynamic-image="{&quot;https://m.media-amazon.com/a.jpg&quot;:[100,100],&quot;https://m.media-amazon.com/b.jpg&quot;:[500,500]}">`;
    const parsed = parseAmazonPage(html, amazonBase);
    expect(parsed.title).toBe("Blue Kettle : Home");
    expect(parsed.images.map((i) => i.url)).toEqual(["https://m.media-amazon.com/b.jpg"]);
  });

  it("knows the robot check page", () => {
    expect(isAmazonBlockPage(200, AMAZON_CAPTCHA)).toBe(true);
    expect(isAmazonBlockPage(503, "")).toBe(true);
    expect(isAmazonBlockPage(200, AMAZON_HTML)).toBe(false);
  });
});

describe("parseOpenGraph", () => {
  it("reads the Open Graph title, description and image", () => {
    const html = `<head><meta property="og:title" content="Linen Apron"><meta property="og:description" content="Stone washed."><meta property="og:image" content="//cdn.example.com/apron.jpg"></head>`;
    const parsed = parseOpenGraph(html, new URL("https://store.example.com/products/apron"));
    expect(parsed).toEqual({
      title: "Linen Apron",
      description: "Stone washed.",
      bullets: [],
      images: [{ url: "https://cdn.example.com/apron.jpg" }],
    });
  });
});

describe("sellerNotesFrom", () => {
  it("prefers bullets, one per line, and caps at 2000 characters on a line break", () => {
    expect(sellerNotesFrom({ bullets: ["A", "B"], description: "D" })).toBe("A\nB");
    expect(sellerNotesFrom({ bullets: [], description: "D" })).toBe("D");
    const long = sellerNotesFrom({ bullets: Array.from({ length: 30 }, () => "x".repeat(99)), description: "" });
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(long.endsWith("x")).toBe(true);
  });
});
