import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// Thumbnail proxy (unchanged)
app.get("/thumbnail", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const url = `https://thumbnails.roblox.com/v1/assets?assetIds=${id}&size=420x420&format=Png`;
    const robloxRes = await fetch(url);
    const data = await robloxRes.json();

    res.set("Access-Control-Allow-Origin", "*");
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Roblox data" });
  }
});

// AssetDelivery proxy for audio (returns JSON with "location")
app.get("/asset", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const url = `https://assetdelivery.roblox.com/v1/assetId/${id}`;
    const robloxRes = await fetch(url, {
      headers: {
        "Cookie": `.ROBLOSECURITY=CAEaAhAB.E5F279B3C76E42EF1BEC6E0F39D6A0E4F71C257D3391A05A0E2E95D2FB7C51425A0A9D1E9E6630B5A726A8F981DE96920AA38339899D4AFA4242DD15A7519CD6D228A457CA2D40B566C34EC8163BFF25965BDFC5A609132593B599B1BC54ED3114133913D1E89E4BF380AB17F0EE13B463E41A58B10791B37871D8231E834185A2618D6D09703A9D4DEB3BD134655A3AEAA624615019F080035E6E059E0F975AC106F713E6A72BC29D59D7288CAEE23A6607574B9825C56A5D6ACB083B997E6796E72ADEDC77DFA530F471893BE92C89680547F11936B5B24E828677541D68D4BCB41263D3DA843FEDD52E5A6741539DF8F9F60082A5F4275D673FC9FE9C650D840DBCC9CAD88C59A6162DD29191E4945F237CC294FA827D4C0D4583D8F65A9F11DEEFACC101559D8A0070D4F0DC2EB2C64DEF34753CD86A3BAD2A7B2D14F1F0D24E3C1A86080361C8C7EED6E9E488DCB1A273D35E425E6608593E0E9D68076A9949E4C5CAB847D252C54EBB61F0CD4DA997418015CE48C1B9E37F2E6E59B80E03B34BB5686EC6969DD0691CCEF74D38BF707F24733605314015B3CEE1DA3940461BC4E891BEFD6DF318E5D2B5E5BFE67ABE12AB07FF14671F3B45ED44378B238941C9E30770386DC95DB66437DC93BC74DC789A83572B60FE541458EC62F27E8E0D78817DFD6FFAD857832BAA71465E30E75AD87DBBDE8326C3ED85B9621DACFBB927E0977B12F7B690FB796208DC89A3C7FF4BD505131F533C9744C3AA0039E690F7B2EF27E8D0E60FE19C779632C311F03796ACA77C7B10105BE822A82A16C8CB25BFCEB9141B82618486839690529B687620641CD72ADF4B1834E78F789C4995470559B8CD9F552812134294C349872EC426E0F63BFBFC120E9AAB4848FE0BBD3BA59DFA4856EFF3BA493858E6A5B903641D3EE69C79DEAFFB782FEB79E828651854824F6284CD00E5FA9673374FA42D12A7526A9E654C1C3268729089A9E3181715BE4ED5B7923CB24261C3B24D0D7727B3279664E4ECCCF3C05BAA1871D05BE35D8538667BB6E891C1C3807CD31C1DB4FE5BF5811B6DBC13C398014965E940482EC5E2FB835E95BC67A82CC9278AEC7A60A9FB9C55689E8378E3DE2C58BA6C28C66CC31E1EC68AF7B1306FAD210BB4C2C3251C77A59976EC107A72AAA243BC81D4B1F227253887BAE6E9CD7F89D3FB0D3C418E4D1C99D51D23DAAD6532D2350D4AAD147189492BB3272917FEF014BEE60E`
      }
    });
    const data = await robloxRes.json();

    res.set("Access-Control-Allow-Origin", "*");
    res.json(data); // should now include "location"
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Roblox asset" });
  }
});


// optional: endpoint that redirects straight to audio file
app.get("/audio", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const url = `https://assetdelivery.roblox.com/v1/assetId/${id}`;
    const robloxRes = await fetch(url);
    const data = await robloxRes.json();

    if (!data.location) return res.status(404).json({ error: "Audio location not found" });

    res.redirect(data.location);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to resolve audio" });
  }
});

app.listen(PORT, () => {
  console.log(`proxy listening on port ${PORT}`);
});
