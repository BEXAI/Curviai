import { expect, test, type Page } from "@playwright/test";

// Pack operations on the progress board: cancel a running pack (against the
// demo simulation), and run a shot again or add a missing photo (against a
// routed API, since demo packs never need review).

test("cancel asks first, then stops the pack and returns its credits", async ({ page }) => {
  await page.goto("/app/new");
  await page.getByRole("button", { name: "Create pack" }).click();
  await page.waitForURL(/\/app\/jobs\//, { timeout: 15000 });
  await expect(page.getByTestId("job-status")).toBeVisible({ timeout: 15000 });

  await page.getByTestId("cancel-pack").click();
  const confirm = page.getByTestId("cancel-confirm");
  await expect(confirm).toContainText("goes back to your balance");
  // Changing your mind keeps the pack running.
  await confirm.getByRole("button", { name: "Keep it running" }).click();
  await expect(page.getByTestId("cancel-confirm")).toHaveCount(0);

  await page.getByTestId("cancel-pack").click();
  await page.getByTestId("cancel-confirm").getByRole("button", { name: "Yes, cancel pack" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("Canceled");
  await expect(page.getByTestId("pack-action-notice")).toContainText("went back to your balance");
  await expect(page.getByTestId("cancel-pack")).toHaveCount(0);
});

const JOB_ID = "00000000-0000-4000-8000-00000000e501";

function packView(state: "done" | "retrying") {
  return {
    id: JOB_ID,
    productId: "00000000-0000-4000-8000-000000000101",
    productTitle: "Juniper glass water bottle",
    status: state === "done" ? "done" : "generating",
    mode: "listing",
    channels: ["amazon.main", "amazon.secondary"],
    creditsReserved: 4,
    creditsCharged: 3.5,
    createdAt: "2026-09-28T10:00:00.000Z",
    canManage: true,
    followUpRunning: state === "retrying",
    shots: [
      {
        shotId: "s01_amazon_main",
        shotType: "amazon_main",
        providerStage: "pixel pipeline",
        status: "done",
        channels: ["amazon.main"],
        credits: 0.5,
        compliance: { pass: true, fillPct: 85, background: [255, 255, 255] },
      },
      {
        shotId: "s02_lifestyle",
        shotType: "lifestyle",
        providerStage: "image model",
        status: state === "done" ? "needs_review" : "generating",
        channels: [],
        credits: 0,
        compliance: null,
        note: state === "done" ? "It did not meet our quality bar, so we held it back. No credits were charged for it." : null,
        action: state === "done" ? "retry" : null,
      },
      {
        shotId: "skipped_01_alt_angle_white:back",
        shotType: "alt_angle_white:back",
        providerStage: "",
        status: "skipped",
        channels: [],
        credits: 0,
        compliance: null,
        label: "Needs photo",
        note: "Add a photo of this angle to get this shot. No credits were charged for it.",
        action: state === "done" ? "add_photo" : null,
        angle: "back",
      },
    ],
  };
}

async function routePack(page: Page): Promise<{ retried: () => boolean }> {
  let retried = false;
  await page.route(`**/api/jobs/${JOB_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ job: packView(retried ? "retrying" : "done") }),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}/files`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: JOB_ID, status: "done", files: [] }),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}/shots/s02_lifestyle/retry`, (route) => {
    retried = true;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ job: packView("retrying"), creditsHeld: 2 }),
    });
  });
  return { retried: () => retried };
}

test("a shot that needs review can run again after a confirmation", async ({ page }) => {
  const api = await routePack(page);
  await page.goto(`/app/jobs/${JOB_ID}`);
  const card = page.getByTestId("shot-card").filter({ hasText: "Lifestyle" });
  await expect(card).toHaveAttribute("data-shot-status", "needs_review");

  await card.getByTestId("retry-shot").click();
  await expect(card.getByTestId("retry-confirm")).toContainText("charged only if it passes");
  expect(api.retried()).toBe(false);
  await card.getByRole("button", { name: "Yes, run it again" }).click();

  await expect(page.getByTestId("pack-action-notice")).toContainText("2 credits are held");
  await expect(card).toHaveAttribute("data-shot-status", "generating");
  await expect(page.getByTestId("job-status")).toHaveText("Generating");
  await expect(page.getByTestId("cancel-pack")).toHaveText("Stop these shots");
  expect(api.retried()).toBe(true);
});

test("a skipped shot that needs a photo offers to add it", async ({ page }) => {
  await routePack(page);
  await page.goto(`/app/jobs/${JOB_ID}`);
  const card = page.getByTestId("shot-card").filter({ hasText: "Needs photo" });
  await expect(card.getByTestId("add-photo")).toHaveText("Add the back photo");

  await card.getByTestId("add-photo-input").setInputFiles({
    name: "back.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await expect(card.getByTestId("add-photo-confirm")).toContainText("Use back.png as the back photo?");
  // Demo mode has no storage, so the upload explains itself instead of failing silently.
  await card.getByRole("button", { name: "Yes, use this photo" }).click();
  await expect(card.getByRole("alert")).toContainText("Photo uploads are not available on this server yet.");
});
