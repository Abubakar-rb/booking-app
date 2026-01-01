require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");

const app = express();

const { SHOPIFY_STORE, SHOPIFY_API_TOKEN, PORT } = process.env;

app.use(bodyParser.json());
app.use(cors());

const shopify = axios.create({
  baseURL: `https://${SHOPIFY_STORE}/admin/api/2024-01`,
  headers: {
    "X-Shopify-Access-Token": SHOPIFY_API_TOKEN,
    "Content-Type": "application/json"
  }
});

function isOverlapping(newB, existing) {
  return existing.some(b =>
    new Date(newB.start) < new Date(b.end) &&
    new Date(b.start) < new Date(newB.end)
  );
}

async function getBookings(productId) {
  try {
    const res = await shopify.get(`/products/${productId}/metafields.json`);
    console.log("Metafields returned from Shopify:", res.data.metafields);

    const field = res.data.metafields.find(f => f.namespace === "custom" && f.key === "booking");
    console.log("Booking metafield found:", field);

    const bookings = field ? JSON.parse(field.value || "[]") : [];
    console.log("Parsed bookings:", bookings);

    return { metafield: field || null, bookings };
  } catch (err) {
    console.error("Error fetching bookings:", err);
    return { metafield: null, bookings: [] };
  }
}

async function saveBookings(productId, metafield, bookings) {
  if (metafield) {
    await shopify.put(`/metafields/${metafield.id}.json`, { metafield: { value: JSON.stringify(bookings), type: "json" } });
  } else {
    await shopify.post(`/products/${productId}/metafields.json`, { metafield: { namespace: "custom", key: "booking", type: "json", value: JSON.stringify(bookings) } });
  }
}

app.get("/availability", async (req, res) => {
  try {
    const productId = req.query.product_id;
    if (!productId) return res.json({ bookings: [] });
    const { bookings } = await getBookings(productId);
    res.json({ bookings });
  } catch {
    res.json({ bookings: [] });
  }
});

app.post("/webhooks/orders-create", async (req, res) => {
  try {
    const order = req.body;
    if (!order?.line_items) return res.status(400).send("No line_items found");

    for (const item of order.line_items) {
      const checkIn = item.properties?.find(p => p.name === "Check In")?.value;
      const checkOut = item.properties?.find(p => p.name === "Check Out")?.value;
      if (!checkIn || !checkOut || !item.product_id) continue;

      const booking = { start: new Date(checkIn).toISOString(), end: new Date(checkOut).toISOString() };
      const { metafield, bookings } = await getBookings(item.product_id);
      if (isOverlapping(booking, bookings)) continue;

      bookings.push(booking);
      await saveBookings(item.product_id, metafield, bookings);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("ERROR");
  }
});

app.listen(PORT || 3000, () => {
  console.log("🚀 Booking server running");
});