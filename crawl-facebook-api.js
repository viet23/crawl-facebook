const express = require("express");
const puppeteer = require("puppeteer");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(bodyParser.json());

async function crawlFacebookPage(url) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"], // cần cho môi trường Linux/VPS
  });

  const page = await browser.newPage();
  const mobileUrl = url.replace("www.facebook.com", "m.facebook.com");

  await page.goto(mobileUrl, { waitUntil: "domcontentloaded" });
  await new Promise((resolve) => setTimeout(resolve, 3000)); // thay waitForTimeout()

  const result = await page.evaluate(() => {
    const name = document.querySelector("title")?.innerText || "";
    const description = document.querySelector('[data-sigil="m-feed-voice-subtitle"]')?.innerText || "";
    const bodyText = document.body.innerText || "";

    return {
      name,
      description,
      bodyPreview: bodyText.slice(0, 1000),
    };
  });

  await browser.close();
  return result;
}

app.post("/analyze-facebook", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Thiếu URL fanpage" });

  try {
    const data = await crawlFacebookPage(url);
    res.json({ success: true, data });
  } catch (err) {
    console.error("❌ Crawl lỗi:", err);
    res.status(500).json({ success: false, error: "Không crawl được trang" });
  }
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`🚀 API đang chạy tại http://localhost:${PORT}/analyze-facebook`);
});
