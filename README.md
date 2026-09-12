# MiniMax H3 Mobil Kontrol

ComfyUI'deki `minimaxH3T2VI2VREF2VAdvanced_v20` workflow'u için, telefondan kullanılabilecek
sade bir kontrol paneli. Node graph göstermez; yalnızca workflow'daki gerçek düğümlere bağlı
birkaç ayarı (prompt, girdi görseli, seed, en-boy oranı, süre/FPS, model, LoRA'lar,
gelişmiş: megapiksel/adım/denoise) sunar ve Generate'e bastığınızda ComfyUI'nin kendi
`/prompt` API'sine gönderir. Ayrıca eski PNG çıktılarından ayar içe aktarma ve ComfyUI'nin
output klasörünü tarayan bir galeri içerir. ComfyUI kurulumunuza, workflow dosyanıza veya
custom node'lara hiçbir şekilde dokunmaz — bağımsız bir ön yüzdür.

## Mimari

İki ayrı süreç `npm run dev` ile birlikte başlar:

- **Vite dev sunucusu** (`:5173`) — React arayüzünü servis eder, telefonun tek bağlandığı adres.
  `/comfy-api` ve `/comfy-ws` isteklerini ComfyUI'ye (`VITE_COMFYUI_URL`), `/api` isteklerini
  aşağıdaki küçük backend'e proxy'ler.
- **Output backend** (`server/index.js`, `:5175`) — yapılandırılmış output klasörlerini (bkz.
  §3, birden fazla "kaynak" olabilir) okuyan küçük bir Express sunucusu. ComfyUI'nin kendisiyle
  hiçbir bağlantısı yok; generation/`/prompt` akışına dokunmaz, sadece diskteki bitmiş dosyaları
  listeler/stream eder.

## Nasıl çalışıyor

### 1. Generate (Oluştur sekmesi)

`src/workflow/template.json`, sizin verdiğiniz JSON'un projeye alınmış kopyasıdır. Uygulama
her "Oluştur"a basıldığında bu şablonu klonlar, yalnızca aşağıdaki node'ların `inputs`
alanlarını değiştirir ve öyle gönderir — şablonun kendisi hiç değişmez:

| UI alanı | Node id | Node / alan |
|---|---|---|
| Prompt | `138` | `PrimitiveStringMultiline.value` |
| Girdi görseli | `687` | `LoadImageCrop.image` (önce `/upload/image` ile yüklenir) |
| Seed | `142` | `easy seed.seed` |
| En-boy oranı | `115` | `ResolutionSelector.aspect_ratio` |
| Süre (saniye) | `132` | `PrimitiveFloat.value` |
| FPS | `149` | `PrimitiveFloat.value` |
| Model | `646` | `UNETLoader.unet_name` |
| LoRA (10 slot, aç/kapa + güç) | `674` | `Power Lora Loader (rgthree).lora_1..lora_10` |
| Megapiksel *(gelişmiş)* | `115` | `ResolutionSelector.megapixels` |
| Adım sayısı *(gelişmiş)* | `750` | `INTConstant.value` |
| Denoise *(gelişmiş)* | `124` | `BasicScheduler.denoise` |

Bu workflow'da negatif prompt ve CFG üreten bir node bulunmuyor (guider `BasicGuider`, cfg
değeri almıyor), bu yüzden UI'da da yok — var olmayan bir alanı uydurmadık.

Dropdown listeleri (en-boy oranı, model, LoRA dosya listesi) sabit kodlanmadı; uygulama
açılışta çalışan ComfyUI'den `/object_info/...` ile canlı çeker (iki farklı COMBO şeması —
eski `[options[], config]` ve custom-node'ların kullandığı yeni `["COMBO", {options:[...]}]`
— otomatik tanınır).

### 2. PNG'den ayar içe aktarma

"📥 PNG'den Ayarları İçe Aktar" butonu, ComfyUI'nin ürettiği bir PNG'yi seçmenizi sağlar.
PNG hiçbir yere yüklenmez — metadata'sı doğrudan tarayıcıda okunur:

- `src/utils/pngMetadata.ts`, PNG dosyasının `tEXt`/`zTXt` chunk'larını binary olarak parse
  eder (ComfyUI bu bilgiyi `prompt` anahtarıyla, çalıştırılan workflow'un tam API-JSON'u
  olarak gömer).
- `src/workflow/pngImport.ts`, bu JSON içinde yukarıdaki tabloyla **aynı** `class_type` +
  node başlığı eşlemesini arar (yeni/uydurma bir mapping değil — `fieldMap.ts` ile birebir
  aynı kaynak). Bulduğu her alanı UI'ya doldurur, bulamadığını "Bulunamadı" olarak listeler.
- Girdi görseli de dahildir: PNG'nin üretildiği anda kullanılan `LoadImageCrop.image` dosya adı
  ComfyUI'nin `input` klasöründe hâlâ duruyorsa, görsel yeniden yüklenmeden doğrudan
  önizlenir ve kullanılır.
- Metadata bulunamazsa ("Bu PNG dışarıda üretilmiş" veya metadata kaydı kapalıysa) açık bir
  hata mesajı gösterilir.

### 3. Output Browser (Galeri sekmesi)

Artık ComfyUI'nin `/history`'sine değil, doğrudan diskteki output klasörlerine bakar — bu daha
güvenilir, çünkü ComfyUI'nin bellek-içi history'si dolup eski kayıtları düşürebilir ama diskteki
dosyalar kalıcıdır.

**Birden fazla kaynak:** Galeri, tek bir klasörle sınırlı değil — `server/index.js`'teki
`SOURCE_DEFS` listesi, her biri kendi env değişkeniyle yapılandırılan adlı "kaynak"lar tanımlar:

| id | Etiket | Env değişkeni |
|---|---|---|
| `comfyui` | ComfyUI | `COMFYUI_OUTPUT_DIR` |
| `forge` | Forge | `FORGE_OUTPUT_DIR` |

Sadece `.env`'de tanımlı (klasörü ayarlanmış) kaynaklar Galeri'de sekme olarak görünür — biri
eksikse o sekme hiç gösterilmez, hataya düşmez. Yeni bir araç daha eklemek isterseniz
`SOURCE_DEFS`'e bir satır + `.env`'e karşılık gelen değişkeni eklemeniz yeterli; her kaynak
kendi kök klasörüne tamamen izole (bkz. güvenlik notu aşağıda).

Backend endpoint'leri (`server/index.js`, `:5175`, Vite üzerinden `/api` altında proxy'lenir),
hepsi bir `source=<id>` query param'ı alır (belirtilmezse `comfyui` varsayılır):

| Endpoint | Açıklama |
|---|---|
| `GET /api/outputs/sources` | Yapılandırılmış kaynakların listesi: `{id,label,configured}[]`. Galeri'deki sekmeler buradan gelir. |
| `GET /api/outputs?source=…&path=…` | **Tek bir dizin seviyesini** (alt klasörlere otomatik inmez) `{folders: string[], files: OutputFile[]}` olarak listeler; `path` boşsa kaynağın kök klasörü. |
| `GET /api/outputs/file?source=…&name=…` | Dosyayı stream eder (HTTP Range destekli). `.mp4` dosyalarında önce faststart-remux katmanından geçer, bkz. aşağı. |
| `GET /api/outputs/thumbnail?source=…&name=…` | Görseller için `sharp` ile anlık, diske kaydedilmeyen 360px JPEG thumbnail üretir. |
| `GET /api/outputs/download?source=…&name=…` | Orijinal dosyayı (remux edilmemiş, diskteki haliyle birebir) `Content-Disposition: attachment` ile indirir. |

**Klasör gezinme:** `sd-webui-forge-neo`'nun `txt2img-images/` klasörü tarih bazlı alt klasörlere
(`2026-09-03/`, `2026-08-30/`, …) ayrılmış durumda. `/api/outputs` bunu recursive taramaz — sadece
o anki dizin seviyesindeki klasörleri ve dosyaları döndürür (`listDirectory()`). `Gallery.tsx` bir
`currentPath` state'i tutar: kök seviyede sadece klasör kutuları (📁) görünür, birine dokununca
`path` o klasöre ayarlanır ve içindeki görseller listelenir; "⬅ Geri" ile üst klasöre dönülür.
`FORGE_OUTPUT_DIR` artık doğrudan `…/output/txt2img-images`'i işaret ediyor (üst `output/` değil).
`name`/`folders` değerleri her zaman kaynağın kök klasörüne göre tam yol olduğundan
(`2026-08-10/00331-....png` gibi), mevcut `file`/`thumbnail`/`download` endpoint'leri değişmeden
çalışmaya devam ediyor.

**Güvenlik** — dosya sunan üç endpoint (`file`, `download`, `thumbnail`) şu katmanlardan geçer:

1. `resolveSafePath(root, name)` — `..`, mutlak yol enjeksiyonu (`/etc/passwd` gibi) ve
   URL-encode edilmiş varyantları normalize edilip seçilen kaynağın kendi kök klasörü dışına
   çıkan her sonuç reddedilir (400); bir kaynağın dosya adıyla başka bir kaynağın (veya
   sistemin herhangi bir yerinin) klasörüne erişilemez. `curl` ile `../../../../etc/passwd`
   denenerek doğrulandı.
2. `resolveSafeRealPath` — yukarıdaki kontrol sadece istenen yol *string*'ini doğrular; klasör
   içine dıştan bir yere işaret eden bir symlink konursa bu tek başına yeterli olmaz. Bu adım
   `fs.realpath` ile aynı kapsama kontrolünü gerçek hedef üzerinde tekrarlar. Test: kök klasöre
   `.png` uzantılı ama `/etc/passwd`'e işaret eden bir symlink konup istendi, 400 ile reddedildi.
3. `assertBrowsableExt` — liste endpoint'i sadece görsel/video uzantılarını döndürse de, `file`
   ve `download` daha önce klasördeki **her türlü dosyayı** (uzantısı ne olursa olsun) native
   content-type'ıyla servis ediyordu; yanlışlıkla oraya düşen bir `.html`/`.svg` aynı origin'den
   render edilebilirdi. Artık üçü de aynı `.png/.jpg/.jpeg/.webp/.gif/.mp4/.webm` beyaz
   listesini zorunlu kılıyor (415 ile reddeder). Test: klasöre `.txt` dosyası konup `/file`'dan
   istendi, 415 ile reddedildi.

Ayrıca: `HttpError` dışındaki ham hatalar (örn. `fs.stat` başarısızlığı) artık istemciye asla
`err.message` olarak geri dönmüyor — bu mesajlar sunucunun mutlak dosya yollarını içerebiliyordu
(`sendError()`). İstemci her zaman sabit, genel bir mesaj görür; gerçek hata sadece sunucu
log'una yazılır.

**Ölçek:** `sd-webui-forge-neo` gibi uzun süredir kullanılan bir output klasörü binlerce dosya
içerebilir (test ortamında Forge kaynağı 5000+ dosya döndürdü). Galeri bunu tek seferde DOM'a
basmıyor — `Gallery.tsx` başlangıçta 60 öğe gösterir, "Daha Fazla Yükle" butonuyla 60'ar 60'ar
büyütür; kaynak değiştirildiğinde sayaç sıfırlanır. Bu olmasaydı telefon tarayıcısı binlerce
karo render etmeye çalışıp ciddi şekilde yavaşlardı.

**Video oynatma düzeltmesi (faststart):** `VHS_VideoCombine`'ın ürettiği `.mp4` dosyalarında
`moov` atomu (HTML5 `<video>`'nun oynatmaya başlamadan önce okuması gereken index/metadata)
dosyanın **sonunda** yer alıyor — bu, dosyayı indirmeyi etkilemez ama mobil tarayıcıların
`<video>` etiketiyle oynatmasını engelliyordu (bu davranış gerçek çıktı dosyaları üzerinde
doğrulandı: `ftyp → free → mdat → moov` sırası). `server/index.js`, `.mp4` isteklerinde
sistemde kurulu `ffmpeg` ile **yeniden kodlamadan** (`-c copy -movflags +faststart`, sadece
container'ı yeniden düzenler, saniyenin altında sürer) bir kopya üretip `server/cache/faststart/`
altında önbelleğe alır ve onu stream eder — orijinal dosyaya asla dokunulmaz. Kopya, önbellekte
yoksa ilk istekte oluşturulur, sonrasında anında servis edilir. `ffmpeg` sistemde yoksa veya
remux başarısız olursa sessizce orijinal dosyaya geri döner (log'a uyarı yazar), üretim akışını
hiçbir şekilde etkilemez. `.webm` dosyalarında bu sorun olmadığı için dokunulmaz.

Eşzamanlı en fazla **2** ffmpeg süreci çalışır (`runQueued`/`MAX_CONCURRENT_REMUX`), fazlası
kuyruğa girer. Bunun nedeni gerçek bir olay: video karolarına önceden gerçek bir `<video src>`
verildiğinde, yüzlerce çıktısı olan bir klasörde galeri açılır açılmaz onlarca ffmpeg süreci
aynı anda tetiklenip CPU'yu kilitledi ve kullanıcının asıl açmak istediği video bu kuyrukta
sonsuza kadar bekledi. Bunun üzerine video karoları artık hiç kaynak yüklemiyor (aşağıda), kuyruk
sınırı ise gelecekte benzer bir yığılmaya karşı ek güvence.

Her karo: görsellerde gerçek thumbnail, videolarda statik bir ▶ ikonu (kasıtlı — bkz. yukarıdaki
olay), dosya adı, tarih + boyut, indirme butonu (ve PNG'lerde metadata butonu, bkz. §4) gösterir;
karoya tıklanınca popup içinde açılır.

### 4. PNG metadata görüntüleme/paylaşma

PNG karolarında "📋 Metadata" butonu, dosyayı indirmeden sadece gömülü metadata'yı çıkarır ve bir
popup'ta gösterir:

- `src/utils/pngMetadata.ts`'teki (PNG içe aktarma özelliğiyle paylaşılan) `readPngTextChunks`
  ile PNG'nin tEXt/zTXt chunk'ları okunur; `extractShareableMetadataText` şu önceliği uygular:
  A1111/Forge tarzı `parameters` metni varsa onu (zaten insan-okunur, prompt/negative
  prompt/sampler/seed içeren düz metin bloğu), yoksa ComfyUI'nin `prompt` (workflow JSON'u)
  alanını döndürür; ikisi de yoksa "bulunamadı" mesajı gösterilir.
- Dosya yine de bir kez indirilir (metadata'yı okumak için baytlara erişmek gerekiyor) ama
  kullanıcının cihazına **kaydedilmez** — sadece bellekte parse edilip atılır; ekrana yalnızca
  çıkarılan metin gelir.
- Popup'ta: metni gösteren salt-okunur bir `<textarea>` (dokunup elle seçip kopyalamak her zaman
  çalışır), destekleniyorsa bir "📤 Paylaş" butonu (`navigator.share` — bu uygulama düz HTTP/LAN
  üzerinden servis edildiği için, `crypto.randomUUID()`'da yaşanan secure-context kısıtı burada
  da geçerli; desteklenmiyorsa buton hiç görünmez) ve iki farklı amaçlı "gönder" butonu:
- **"📝 Ayarları + Resmi Gönder"** (sadece tanınan bir şey varsa görünür): aynı taramadan çıkan
  ayarları **ve** bu PNG'nin kendisini birlikte Oluştur ekranına uygular ve sekmeyi değiştirir —
  yani "bu geçmiş üretimi baz alıp devam et" senaryosu. Görsel önce ComfyUI'nin `/upload/image`
  API'siyle yüklenir, dönen dosya adı `inputImage` olarak ayarlara eklenir (metadata'nın kendi
  içinde eski bir referans görsel bulunsa bile, gönderilen her zaman şu an popup'ta açık olan
  PNG'dir):
  - ComfyUI'nin `prompt` (workflow JSON) metadata'sı varsa, PNG içe aktarma özelliğiyle **aynı**
    `extractSettingsFromPrompt` fonksiyonu kullanılır — prompt, seed, model, LoRA, resolution,
    süre gibi tanınan her alan dolar.
  - A1111/Forge `parameters` metni varsa (farklı bir araç, bu workflow'un node'larıyla eşleşen
    bir yapısı yok) sadece pozitif prompt metni ("Negative prompt:" öncesi kısım) Oluştur
    ekranının Prompt alanına aktarılır — geri kalan ayarlar (seed, sampler, vb.) bu workflow'a
    anlamlı şekilde eşlenemediği için değiştirilmez, ama görsel yine de gönderilir.
  - Hiçbir tanınan ayar yoksa bu buton hiç gösterilmez.
- **"🖼️ Sadece Resmi Gönder"** (metadata'dan tamamen bağımsız, her PNG'de görünür): sadece bu
  PNG'yi yükleyip Oluştur ekranının girdi görseli olarak ayarlar, başka hiçbir ayara dokunmaz.
  Özellikle Forge çıktıları için önemli — onların bu workflow'la eşleşen bir ayar seti yok, ama
  görselin kendisi image-to-video için gayet kullanılabilir bir başlangıç karesi.
  Her iki buton da yükleme sırasında birbirini devre dışı bırakır (aynı anda iki gönderim olmasın diye).

### 5. Popup görüntüleyici

`src/components/FullscreenViewer.tsx`, karartılmış bir arka plan üzerinde ortalanmış bir popup
olarak açılır — **browser'ın native Fullscreen API'sini kasıtlı olarak çağırmaz**. İlk sürümde
`requestFullscreen()` (video elementinin kendisinde bile) bazı mobil tarayıcılarda videonun hiç
başlamadığı, gri bir karede takılı kaldığı bir duruma yol açtı; bu API'yi tamamen çıkarmak
sorunu ortadan kaldırdı ve davranışı cihazlar arasında çok daha öngörülebilir hale getirdi. Sabit
konumlu overlay yine de ekranın büyük kısmını kaplar. Arka plana tıklama, X butonu ve Escape
tuşuyla kapanır.

### 6. Gerçek zamanlı üretim ilerlemesi

`useComfyGeneration`, WebSocket bağlantısı üzerinden gelen gerçek ComfyUI mesajlarını ayrıştırır:

- `progress` mesajları (`{value, max, node}`) → aktif sampling adımını **"Sampling 5 / 8"**
  ve yüzde olarak gösterir. Bu mesajlar hangi node'a ait olduğunu taşıdığı için, node
  değiştiğinde (`executing` mesajı yeni bir node id verdiğinde) eski sampling verisi sıfırlanır
  — böylece VAE Decode gibi sonraki bir adımda eski "5/8" değeri yanlışlıkla gösterilmez.
- `executing` mesajları → hangi node'un çalıştığını (`_meta.title`'dan okunan insan-okunur ad)
  ve şimdiye kadar kaç farklı node'un çalıştığını takip eder. `execution_cached` mesajları da
  (aynı ayarlarla tekrar üretimde ComfyUI birçok node'u yeniden çalıştırmadan "cached" olarak
  atlar — gerçek bir çalıştırmada 25 node'dan 21'i cached çıktı) bu sayaca ekleniyor; yoksa
  sampling dışı adımlarda gösterilen genel workflow ilerlemesi (`çalışan node sayısı / toplam
  node sayısı`) neredeyse hep 0'da takılı kalıyordu.
- Geçen süre her saniye günceller; **kalan süre (ETA)**, yalnızca aktif sampling fazının kendi
  başlangıcından bu yana ölçülen adım hızından hesaplanır ve ilk adımda "Hesaplanıyor…" gösterir
  (tek örnekten uydurma bir tahmin üretmez).
- Tamamlandığında toplam süre + "Sonucu Görüntüle" (videoya kaydırır) gösterilir.
- **İptal**: `POST /interrupt` çağrılır, progress state'i tamamen sıfırlanır (kalıntı sampling/
  node verisi kalmaz).

**Tamamlanma tespiti için `/history` polling (güvenlik ağı):** Bu workflow'da gerçek bir üretim
birkaç dakika sürebiliyor (test edilen bir çalıştırma ~4 dakika sürdü). Telefonun ekranı bu süre
içinde kilitlenirse veya sekme arka plana alınırsa, mobil tarayıcılar WebSocket bağlantısını ve
JS timer'larını sessizce askıya alabiliyor — bu durumda ComfyUI'nin gönderdiği "bitti" (`executing`
`node: null`) mesajı hiç ulaşmıyor ve arayüz gerçekte tamamlanmış bir üretimde bile sonsuza kadar
"Sırada bekleniyor…" durumunda kalıyordu (video de hiç görünmüyordu, çünkü tamamlanma hiç
işlenmemişti). Bunu çözmek için `useComfyGeneration`, aktif bir prompt varken her 5 saniyede bir
`GET /history/{prompt_id}`'i de kontrol ediyor (`HISTORY_POLL_MS`) — WS mesajı gelmese bile
`status.completed` göründüğü an sonucu işliyor. Ayrıca sekme tekrar görünür olduğunda
(`visibilitychange`) bir sonraki tur beklenmeden hemen bir kontrol tetikleniyor. WS ve poll aynı
`finishFromHistory` fonksiyonunu paylaşıyor ve `activePromptId` koruması sayesinde ikisi aynı anda
tetiklense bile sonuç iki kez işlenmiyor. Bu, `/history`'nin "sadece bitmiş üretimin sonucunu almak
için kullanılır, progress takibi için ayrı bir polling sistemi kurulmaz" ilkesiyle çelişmiyor —
WS hâlâ birincil ve anlık kaynak, poll sadece WS'in güvenilir olmadığı (arka plana alma) tek bir
durum için var olan bir yedek.

## Kurulum ve çalıştırma

Bu klasör (`mobile-control`) ComfyUI kurulumunuzdan tamamen ayrı, bağımsız bir projedir.

1. **`.env` dosyasını ayarlayın** (`.env.example`'dan kopyalanmıştır, gerekirse düzenleyin):

   ```
   VITE_COMFYUI_URL=http://192.168.1.65:8188
   COMFYUI_OUTPUT_DIR=/home/emir/Desktop/ComfyUI/output
   FORGE_OUTPUT_DIR=/home/emir/Desktop/sd-webui-forge-neo/output/txt2img-images
   OUTPUT_SERVER_PORT=5175
   ```

   `FORGE_OUTPUT_DIR` opsiyoneldir — satırı silerseniz veya boş bırakırsanız Galeri'de sadece
   ComfyUI sekmesi görünür.

2. **Bağımlılıkları kurun** (bir kere):

   ```bash
   cd "mobile-control"
   npm install
   ```

3. **PC'de başlatın** (ComfyUI zaten `python main.py` ile çalışıyor olmalı):

   ```bash
   npm run dev
   ```

   Bu komut Vite'ı **ve** output backend'ini birlikte başlatır. Konsolda şöyle bir çıktı
   göreceksiniz:

   ```
   [vite] ➜  Network: http://192.168.1.65:5173/
   [output-server] http://localhost:5175 (ComfyUI=/home/emir/Desktop/ComfyUI/output, Forge=/home/emir/Desktop/sd-webui-forge-neo/output)
   ```

4. **Telefondan** (aynı Wi-Fi/LAN'da), tarayıcıda şu adresi açın:

   ```
   http://192.168.1.65:5173/
   ```

5. **Firewall**: PC'de yalnızca **5173** portu LAN'a açık olmalı. `8188` (ComfyUI) ve `5175`
   (output backend) telefona hiç açılmıyor — ikisi de Vite proxy'si üzerinden, PC'nin kendi
   içinden erişiliyor.

## Üst menü: Üret / Galeri / ⚙

Üst menü üç öğe: **Üret**, **Galeri**, **⚙ (Ayarlar)**.

- **Üret** — normal dokunuş en son açık alt-görünüme gider; **uzun basış** soldan bir çekmece
  açar: **Görsel** (SDXL/Krea2), **Video**, **OpenWebUI**.
- **OpenWebUI** — aynı PC'deki `:3000` örneği, `<iframe>` ile gömülü. `src` panelin açıldığı
  host'tan türetilir (`window.location.hostname` + `:3000`), yani hem LAN'da hem Tailscale'de
  ek ayar olmadan çalışır. İlk kez açılana kadar yüklenmez, sonra (gizli de olsa) mount'ta
  kalır ki sekme değişince chat oturumu düşmesin. Panel HTTPS'e taşınırsa (`http` OpenWebUI)
  mixed-content'e takılır — o yüzden köşede "Tarayıcıda aç" bağlantısı var.
- **Galeri** ve **⚙** sıradan sekmeler.

## Paneli sürekli açık tutmak (systemd) + Ayarlar sekmesi

Ayarlar sekmesindeki **"ComfyUI'yi Durdur"** düğmesinin paneli de kapatmaması için panel,
ComfyUI'den ayrı bir **systemd kullanıcı servisi** olarak çalışır. Bir kez kurulur:

```bash
# repo'daki kopyayı yerine koy (yol farklıysa bu satırı kendine göre uyarla)
cp mobile-control/systemd/mobile-control.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mobile-control      # şimdi başlat + her açılışta başlat
systemctl --user status mobile-control
journalctl --user -u mobile-control -f            # canlı log
```

> nvm ile node sürümü değiştirirsen `~/.config/systemd/user/mobile-control.service` içindeki
> `v24.14.0` yolunu güncelle (`nvm which current`).

Bundan sonra `start-all.sh` **yalnızca ComfyUI** başlatır. Ayarlar sekmesi (`server/index.js`
içindeki `/api/system/*` rotaları):

- **Modeller (llama-swap)** — `LLAMA_SWAP_URL`'deki her modeli aç/kapat. Aç = ilgili modele
  bir istek atıp yüklenmesini tetikler; kapat = `POST /api/models/unload/:id`.
- **ComfyUI (start-all.sh)** — `START_ALL_SCRIPT`'i kendi süreç grubunda başlatır/durdurur;
  8188 portunu yoklayıp "çalışıyor mu" durumunu gösterir. "Durdur" yalnızca bu panelden
  başlatılan kopyayı kapatır.
- **Bilgisayarı Kapat** — çift onaylı; `systemctl poweroff` (aktif masaüstü oturumu polkit
  üzerinden sudo'suz izin verir).

## Test

Backend için ayrı bir test suite'i yok (proje küçük, tek dosyalık bir Express sunucusu).
Değişiklikler şu şekilde uçtan uca doğrulandı:

- `GET /api/outputs/sources`, `GET /api/outputs?source=comfyui|forge` — her iki gerçek klasörle
  (ComfyUI: ~1000, Forge: ~5000 dosya) listeleme; `forge` kaynağının alt klasörlerdeki (`images/`,
  `txt2img-images/…`) dosyaları da doğru şekilde döndürdüğü doğrulandı.
  `GET /api/outputs/file|thumbnail|download?source=…&name=…` her iki kaynak için `curl` ile ayrı
  ayrı test edildi (thumbnail üretimi, video `Range` isteği [206 Partial Content], download
  header'ları).
- Path traversal denemesi (`../../../../etc/passwd`, `source=forge` ile de) → 400 ile reddedildi.
- Bir Forge PNG'sinin gerçek `parameters` chunk'ı hem Python hem de projedeki chunk-okuma
  mantığının birebir Node.js karşılığıyla ayrıştırılıp aynı sonucu verdiği doğrulandı.
- Vite proxy zinciri (`/api`, `/comfy-api`, `/comfy-ws`) çalışan gerçek ComfyUI örneğine karşı
  uçtan uca (WebSocket dahil) test edildi.
- Gerçek bir çıktı PNG'sinin metadata'sı incelenerek `pngImport.ts`'nin aradığı `class_type`/
  başlık eşlemesinin gerçek veriyle birebir örtüştüğü doğrulandı.
- Faststart remux: gerçek bir `VHS_VideoCombine` çıktısında `moov` atomunun dosya sonunda
  olduğu (`ftyp → free → mdat → moov`) doğrulandı; remux sonrası `ftyp → moov → free → mdat`
  sırasına geçtiği, `ffprobe` ile video/ses stream'lerinin ve süresinin bozulmadığı, ikinci
  istekte önbellekten anında servis edildiği ve orijinal dosyanın hiç değişmediği doğrulandı.
  Eşzamanlı remux kuyruğu, 50 eşzamanlı sahte işle simüle edilip hiçbir zaman 2'yi aşmadığı
  doğrulandı.
- `npm run build` ve `npm run lint` temiz geçiyor.

## Notlar

- ComfyUI kapalıyken sayfa açılırsa model/LoRA dropdown'ları boş gelir ve altta bir hata
  mesajı görürsünüz; ComfyUI ayağa kalkınca sayfayı yenilemeniz yeterli.
- Bir kaynağın env değişkeni ayarlanmamışsa veya yanlışsa, o kaynağın sekmesi hiç görünmez
  (ilk kaynak otomatik seçilir); yanlışlıkla `?source=` ile doğrudan çağrılırsa 503 ile anlaşılır
  bir hata döner. Her iki durumda da ComfyUI'nin kendisi veya generation akışı etkilenmez.
- Video dosyaları için galeri karosunda gerçek bir önizleme **yok** (kasıtlı, bkz. §3) — sadece
  statik bir ▶ ikonu var; videoyu görmek için karoya dokunup popup'ı açmanız gerekir. `ffmpeg`
  yalnızca `.mp4` faststart-remux için kullanılıyor (sisteminizde zaten kurulu olmalı, çünkü
  ComfyUI'nin `VHS_VideoCombine` node'u da video üretmek için ffmpeg'e ihtiyaç duyuyor).
- Workflow dosyanızda değişiklik yaparsanız (yeni node, yeniden numaralandırma vb.),
  `src/workflow/template.json` ve `src/workflow/fieldMap.ts` içindeki node id eşlemesini
  buna göre güncellemeniz gerekir — `pngImport.ts` bu eşlemeyi otomatik olarak yeniden kullanır.
- Yeni bir output kaynağı eklemek için: `server/index.js`'teki `SOURCE_DEFS` dizisine
  `{ id, label, envVar }` ekleyin, `.env`'e karşılık gelen değişkeni yazın — frontend tarafında
  hiçbir değişiklik gerekmez, sekmeler `/api/outputs/sources`'tan otomatik gelir.
