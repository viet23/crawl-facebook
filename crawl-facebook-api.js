const express = require("express");
const puppeteer = require("puppeteer");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)); // ✅ FIX fetch
require("dotenv").config();

const axios = require("axios");

const app = express();
app.use(cors());
app.use(bodyParser.json());
// Chuyển đổi ratio từ định dạng người dùng sang định dạng Runway chấp nhận
const ratioMap = {
    "1:1": "1024:1024",
    "16:9": "1920:1080",
    "4:3": "1024:768",
    "3:4": "768:1024",
    "9:16": "1080:1920",
    "21:9": "2520:1080",
};

const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY;
const SHOTSTACK_API_KEY = "fHK6q16tBau8galfuCqHp7d1K98zOqnluqIZZQAQ"; // <- Thay bằng key thật
const SHOTSTACK_API_URL = "https://api.shotstack.io/v1/render";

async function crawlFacebookPage(url) {
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: "/snap/bin/chromium", // Nếu không dùng snap, bạn có thể bỏ dòng này
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    const mobileUrl = url.replace("www.facebook.com", "m.facebook.com");

    await page.goto(mobileUrl, { waitUntil: "domcontentloaded" });
    await new Promise((resolve) => setTimeout(resolve, 3000));

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

app.post("/generate-image", async (req, res) => {
    console.log("📥 req.body:", req.body);

    const { prompt, resolution, ratio, referenceImage } = req.body;
    if (!prompt) return res.status(400).json({ error: "Thiếu prompt tạo ảnh" });


    const mappedRatio = ratioMap[ratio] || "1024:1024";

    try {
        // Chuẩn bị payload
        const bodyPayload = {
            model: "gen4_image",
            promptText: prompt,
            ratio: mappedRatio,
        };

        // Nếu có referenceImage thì thêm vào body
        if (referenceImage) {
            bodyPayload.referenceImages = [
                {
                    uri: referenceImage,
                    tag: "reference", // tên tag tùy chọn
                },
            ];
        }

        const createRes = await fetch("https://api.dev.runwayml.com/v1/text_to_image", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${RUNWAY_API_KEY}`,
                "Content-Type": "application/json",
                "X-Runway-Version": "2024-11-06",
            },
            body: JSON.stringify(bodyPayload),
        });

        const createData = await createRes.json();
        const taskId = createData?.id;
        if (!taskId) {
            console.error("❌ Không lấy được task ID:", createData);
            return res.status(400).json({ error: "Không lấy được task ID", detail: createData });
        }

        console.log("🧠 Task ID:", taskId);

        // Poll kết quả trong tối đa 60 giây
        let finalImageUrl = "";
        const timeout = Date.now() + 60_000;

        while (Date.now() < timeout) {
            await new Promise((r) => setTimeout(r, 2000));

            const taskRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${RUNWAY_API_KEY}`,
                    "Content-Type": "application/json",
                    "X-Runway-Version": "2024-11-06",
                },
            });

            const taskData = await taskRes.json();
            console.log("🔄 Polling status:", taskData.status);

            if (taskData?.status === "SUCCEEDED") {
                finalImageUrl = taskData.output?.[0];
                break;
            }

            if (["FAILED", "CANCELLED"].includes(taskData?.status)) {
                return res.status(500).json({
                    error: `Task thất bại với trạng thái: ${taskData.status}`,
                    taskId,
                });
            }
        }

        if (!finalImageUrl) {
            return res.status(500).json({
                error: "Tạo ảnh quá thời gian chờ (60 giây)",
                taskId,
            });
        }

        res.json({ success: true, imageUrl: finalImageUrl });
    } catch (err) {
        console.error("❌ Lỗi tạo ảnh:", err);
        res.status(500).json({ success: false, error: "Lỗi khi tạo ảnh từ Runway" });
    }
});


app.post("/generate-video", async (req, res) => {
    const { promptText, promptImage, duration } = req.body;

    if (!promptText || !promptImage) {
        return res.status(400).json({ error: "Thiếu promptText hoặc promptImage" });
    }

    const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY;
    if (!RUNWAY_API_KEY) {
        return res.status(500).json({ error: "Thiếu RUNWAY_API_KEY trong môi trường" });
    }

    // Kiểm tra và giới hạn duration hợp lệ (ví dụ tối đa 15 giây)
    const videoDuration = Math.min(Number(duration) || 5, 15);

    try {
        // Step 1: Gửi yêu cầu tạo video
        const createRes = await fetch("https://api.dev.runwayml.com/v1/image_to_video", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${RUNWAY_API_KEY}`,
                "Content-Type": "application/json",
                "X-Runway-Version": "2024-11-06",
            },
            body: JSON.stringify({
                model: "gen4_turbo",
                promptText,
                promptImage,
                ratio: "1280:720", // Hợp lệ
                duration: videoDuration, // dùng biến động
            }),
        });

        const createData = await createRes.json();
        console.log("🎬 Phản hồi tạo video:", createData);

        const taskId = createData?.id;
        if (!taskId) {
            return res.status(500).json({
                error: "Không lấy được task ID từ Runway",
                details: createData,
            });
        }

        console.log("✅ Task ID video:", taskId);

        // Step 2: Poll kết quả video
        let finalVideoUrl = "";
        const timeout = Date.now() + 60_000;

        while (Date.now() < timeout) {
            await new Promise((r) => setTimeout(r, 2000));

            const taskRes = await fetch(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${RUNWAY_API_KEY}`,
                    "Content-Type": "application/json",
                    "X-Runway-Version": "2024-11-06",
                },
            });

            const taskData = await taskRes.json();
            console.log("📡 Video polling:", taskData.status);

            if (taskData?.status === "SUCCEEDED") {
                finalVideoUrl = taskData.output?.[0];
                break;
            }

            if (["FAILED", "CANCELLED"].includes(taskData?.status)) {
                return res.status(500).json({
                    error: `Task thất bại với trạng thái: ${taskData.status}`,
                    taskId,
                });
            }
        }

        if (!finalVideoUrl) {
            return res.status(500).json({
                error: "Tạo video quá thời gian (timeout)",
                taskId,
            });
        }

        res.json({ success: true, videoUrl: finalVideoUrl });
    } catch (err) {
        console.error("🚫 Lỗi tạo video:", err);
        res.status(500).json({ error: "Lỗi khi tạo video từ Runway" });
    }
});




app.post("/merge-videos", async (req, res) => {
    console.log("req.body", req.body);
    const { videos } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
        return res.status(400).json({ error: "No video URLs provided" });
    }

    let currentStart = 0;
    const defaultClipDuration = 10; // seconds

    const clips = videos.map((url) => {
        const clip = {
            asset: {
                type: "video",
                src: url,
            },
            start: currentStart,
            length: defaultClipDuration,
            transition: {
                in: "fade",
                out: "fade",
            },
        };
        currentStart += defaultClipDuration;
        return clip;
    });
    

    const payload = {
        timeline: {
            background: "#000000", // phải đúng format hex
            tracks: [
                {
                    clips: clips,
                },
            ],
        },
        output: {
            format: "mp4",
            resolution: "sd",
            fps: 25
        }
    };

    try {
        const response = await axios.post("https://api.shotstack.io/v1/render", payload, {
            headers: {
                "x-api-key": SHOTSTACK_API_KEY,
                "Content-Type": "application/json",
            },
        });

        const renderId = response?.data?.response?.id;

        if (renderId) {
            return res.json({
                success: true,
                renderId,
                message: "🎬 Merge started. Check status at /render-status/:id",
            });
        } else {
            return res.status(500).json({ error: "Invalid Shotstack response" });
        }
    } catch (error) {
        console.error("Shotstack merge error:", error?.response?.data || error.message);
        return res.status(500).json({
            error: "Error sending request to Shotstack",
            detail: error?.response?.data || error.message,
        });
    }
});

// Optional: Check render status
app.get("/render-status/:id", async (req, res) => {
    const renderId = req.params.id;

    try {
        const response = await axios.get(`https://api.shotstack.io/v1/render/${renderId}`, {
            headers: {
                "x-api-key": SHOTSTACK_API_KEY,
            },
        });

        res.json(response.data);
    } catch (error) {
        const fullError = error?.response?.data || error.message;
        console.error("Shotstack render status error:", JSON.stringify(fullError, null, 2));
        return res.status(500).json({
            error: "Error checking status",
            detail: fullError,
        });
    }
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
    console.log(`🚀 API đang chạy tại http://localhost:${PORT}`);
});
