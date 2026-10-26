// Browser regression for #3743. Run with Node.js and Playwright installed:
// MINIFLUX_TEST_BROWSER=/path/to/chromium node --test internal/ui/static/testdata/mark_page_as_read.cjs
// Every page and API response is intercepted locally; no Miniflux service is needed.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { after, before, test } = require("node:test");
const { chromium } = require("playwright");

const bundle = ["keyboard_handler.js", "touch_handler.js", "webauthn_handler.js", "app.js"]
    .map(name => readFileSync(join(__dirname, "../js", name), "utf8")).join("\n");
let browser;

before(async () => {
    browser = await chromium.launch({ executablePath: process.env.MINIFLUX_TEST_BROWSER });
});
after(async () => { await browser?.close(); });

async function fixture(t, { unread = true, empty = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, serviceWorkers: "block" });
    t.after(() => context.close());
    const posts = [];
    const unexpected = [];
    const errors = [];
    let documents = 0;
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== "http://miniflux.test") {
            unexpected.push(request.url());
            return route.abort();
        }
        if (url.pathname === "/app.js") {
            return route.fulfill({ contentType: "text/javascript", body: bundle });
        }
        if (url.pathname === "/entries/status" && request.method() === "POST") {
            posts.push(request.postDataJSON());
            return route.fulfill({ contentType: "application/json", body: "20" });
        }
        if (url.pathname === "/category/1/entries") {
            documents++;
            const items = empty ? "" : Array.from({ length: 20 }, (_, i) =>
                `<article class="item item-status-unread" data-id="${i + 1}">Entry ${i + 1}</article>`).join("");
            return route.fulfill({ contentType: "text/html", body: `<!doctype html>
                <title>Category entries</title>
                <style>.item {height: 180px} button {height: 40px}</style>
                <body data-entries-status-url="/entries/status">
                <section class="items">${items}</section>
                <div><button data-action="markPageAsRead" data-show-only-unread="${unread ? "1" : ""}"
                    data-label-question="Mark this page?" data-label-yes="Yes" data-label-no="No"
                    data-label-loading="Loading">Mark this page as read</button></div>
                <a data-page="next" href="/category/1/entries?page=2">Next page</a>
                <script type="module" src="/app.js"></script>` });
        }
        unexpected.push(request.url());
        return route.abort();
    });
    await page.goto("http://miniflux.test/category/1/entries?page=1");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    if (!empty) assert.ok(await page.evaluate(() => window.scrollY) > 1000);
    t.after(() => {
        assert.deepEqual(errors, [], "application script errors");
        assert.deepEqual(unexpected, [], "unexpected network requests");
    });
    return { page, posts, documents: () => documents };
}

test("marking an unread category page starts the next entries at the top", async t => {
    const { page, posts, documents } = await fixture(t);
    await page.getByRole("button", { name: "Mark this page as read", exact: true }).click();
    await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Yes", exact: true }).click(),
    ]);
    assert.equal(documents(), 2);
    assert.equal(page.url(), "http://miniflux.test/category/1/entries?page=1");
    assert.deepEqual(posts, [{ entry_ids: Array.from({ length: 20 }, (_, i) => i + 1), status: "read" }]);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("ordinary reload still restores the reader's scroll position", async t => {
    const { page, posts } = await fixture(t);
    const scroll = await page.evaluate(() => window.scrollY);
    await page.reload();
    assert.equal(await page.evaluate(() => window.scrollY), scroll);
    assert.deepEqual(posts, []);
});

test("marking an all-entries page advances pagination", async t => {
    const { page, posts } = await fixture(t, { unread: false });
    await page.getByRole("button", { name: "Mark this page as read", exact: true }).click();
    await Promise.all([
        page.waitForURL("**/entries?page=2"),
        page.getByRole("button", { name: "Yes", exact: true }).click(),
    ]);
    assert.equal(posts.length, 1);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("an empty page does not submit an update", async t => {
    const { page, posts, documents } = await fixture(t, { empty: true });
    await page.getByRole("button", { name: "Mark this page as read", exact: true }).click();
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    assert.deepEqual(posts, []);
    assert.equal(documents(), 1);
});
