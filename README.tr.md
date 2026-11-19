# redstone-sim

Minecraft **Java Edition** redstone'unu game-tick hassasiyetinde taklit eden bir simülatör.
Bir MCP sunucusu (Claude gibi bir yapay zekâ asistanı devre kurup test edebilsin diye) ve canlı
bir 3D web görüntüleyici içerir.

[English](README.md) · **[Tarayıcıda dene](https://ziacud.github.io/redstone-sim/)** (kurulum yok; tasarımlar tarayıcında kalır)

- Gerçek Minecraft 26.3'ten alınmış, yalnızca desteklenen blokları kullanan **928 kaydın
  hepsinde** oyunla blok blok aynı sonucu verir (1311 kayıt henüz olmayan blok ya da özellik
  gerektiriyor; bkz. [Doğruluk](#doğruluk)).
- Piston, yapışkan piston, slime ve honey, observer, quasi-connectivity ve BUD, 0-tick, blok
  düşürme, update skipping, meşale yanması, flying machine.
- **Sunucu koşulları:** donmuş (unload ya da lazy) chunk'lar, sunucu restart'ı ve bir flying
  machine'i yoğun bir sunucu gibi chunk sınırında durduran sınır tuzakları.
- Arayüzsüz çalışır ve her seferinde aynı sonucu verir: bir scriptle binlerce senaryo
  denenebilir ya da biri 3D izlenebilir.
- **Geri sarma:** bir makinenin nasıl bozulduğunu görmek için tick tick geri gidilebilir.
- **Malzeme listesi:** bir yapının gerektirdiği eşyalar, stack ve shulker kutusu sayıları.
- Hopper, sandık, dropper, dispenser, varil ve shulker kutusu, içlerindeki eşyalarla; nota
  bloğu ve kapılar.
- **Litematica** şemalarını (`.litematic`) açar ve kaydeder, gerçek Java dünyalarını (Anvil
  bölge dosyaları) okur, oyuna yapıştırılabilecek `.mcfunction` dosyaları yazar.

## Nasıl çalışır

Bileşen listesi basitleştirilmedi. Vanilla'nın çalışma modeli JavaScript'e port edildi (bazı
motor dosyaları port ettikleri vanilla sınıfını adıyla anar, ör. `engine/updater.js`
`CollectingNeighborUpdater`'ı port eder):

- zamanlanmış tick'ler (tetik zamanı → öncelik → ekleme sırası), aynı blok için tekilleştirme
- komşu güncellemeleri vanilla sırasıyla (B, D, A, Y, K, G), derinlik-önce toplayan updater ile
- shape update'ler ayrı bir kanal (observer'lar bunu görür)
- her game tick'te vanilla faz sırası: zamanlanmış tick'ler → blok olayları (pistonlar) → blok
  varlıkları (hareket eden pistonlar)
- tozdaki `HashSet` yineleme sırası Java'nın bucket düzeniyle birebir (konuma bağlı toz
  oyundaki gibi davranır)

## Desteklenen bloklar

Redstone tozu, meşale (yer/duvar, yanma), şalter, taş ve meşe buton, repeater (gecikme, kilit),
comparator (karşılaştır/çıkar, konteyner okuma), lamba, observer, piston ve yapışkan piston
(12 blok sınırı, quasi-connectivity, blok düşürme, slime ve honey), redstone bloğu, bakır
lambalar (tüm oksitlenme ve waxed türleri), ahşap ve demir tuzak kapıları ve kapılar, nota
bloğu (enstrüman alttaki bloktan ya da üstteki kafadan), hopper (bekleme süresi, kilit), sandık
ve çift sandık (üstünde iletken blok varsa comparator okuyamaz), dropper, dispenser, varil ve
shulker kutusu, cam, basamak, obsidyen, beton, yün, kuvars, metal bloklar, kalaslar, kütükler,
taş türleri ve çiftlik blokları: toprak, çim, kum, tarla toprağı, su (statik kaynak, akış yok),
şeker kamışı, karpuz, balkabağı ve sapları.

Konteynerler eşya tutar (stack boyutları oyundaki gibi; comparator onları oyunun float
hesabıyla okur). Yerdeki eşyalar (item entity) simüle edilmez: koyacak yeri olmayan dispenser ya
da dropper eşyayı harcar, ve yalnızca düz "eşyayı at" davranışı var (kova, ok, shulker kutusu
gibi özel dispenser eşyaları yok).

Henüz yok: entity'ler, sıvı akışı, ışık, redstone deneyleri ve kompostlayıcı, crafter, sculk
sensör, ray, tripwire hook, çan, kürsü, TNT, yaprak gibi bloklar.

## Tarayıcıda

**https://ziacud.github.io/redstone-sim/** simülatörün tamamını sayfanın içinde çalıştırır: aşağıdaki görüntüleyici, demo
tasarımı, geri sarma, malzeme listesi, `.json`, `.mcfunction` ve `.litematic` açma ve indirme.
Kaydettiğin tasarımlar tarayıcının deposunda saklanır. MCP sunucusu için yerel kurulum gerekir.

Aynı sayfa her statik web sunucusunda çalışır: depo klasörünü sun ve `public/index.html`'i bir
alt yoldan aç ya da adrese `?local` ekle.

## Kurulum

Node.js 20 veya üstü.

```bash
npm install
```

### Sadece 3D görüntüleyici

```bash
node server/index.js --viewer-only --load demo
```

http://localhost:3700/ adresini aç. Arayüz İngilizce ya da Türkçe (yan panelin üstündeki
düğme; varsayılan tarayıcının dili).

- **Tasarımlar:** `designs/` içindeki kayıtlar (tıkla: yükle, indir, sil). **Dosyadan aç** ya da
  sürükle-bırak ile `.json` tasarım, `.mcfunction` (`setblock` ve `fill` komutları oyundaki gibi
  çalıştırılır) ya da Litematica `.litematic` açılır (tüm bölgeler, konteyner eşyaları ve
  bekleyen tick'ler; simülatörün bilmediği bloklar alınmaz ve listelenir).
- **Bu dünya:** ad verip kaydet, `.json`, `.mcfunction` ya da `.litematic` olarak indir, yeni boş
  dünya. Konteynerin üstüne gelince içindeki eşyalar görünür.
- **Sunucu testi:** vanilla gibi restart, chunk dondurma (`C`, sonra bir bloğa tıkla: o chunk
  tick almaz, mavi görünür) ve chunk sınırı tuzağı (`T`): makine sınırı her geçmeye
  kalktığında öte taraf belirlediğin süre tick almaz (ya da bir eklenti piston hareketini
  iptal eder).
- **Paper piston davranışı:** Paper'ın piston taşıma sırası (`allow-piston-duplication: false`).
- **Geri sarma:** üst çubuktaki `−1 gt` / `−10 gt` (ya da `,`) zamanda geri gider. Simülatör her
  32 tick'te dünyanın birebir kopyasını tutar ve aradaki tick'leri yeniden çalıştırır, yani
  geçmiş aynen tekrar oynar. Geri gidilen noktadan sonra yapılan düzenlemeler geri alınır.
- **Malzeme listesi:** dünyanın gerektirdiği her eşya, stack ve shulker kutusu sayısıyla; metin
  olarak kopyalanabilir.

### Claude Code ile (MCP)

Proje kökündeki `.mcp.json` sunucuyu tanıtır. Claude Code'u bu klasörde başlatıp
`redstone-sim` sunucusunu onaylaman yeterli; görüntüleyici adresini `world_info` aracı verir
(genelde http://localhost:3700/). Diğer MCP istemcileri: `node server/index.js` (stdio).

| Araç | Ne yapar |
|---|---|
| `world_info` | Oyun zamanı, çalışıyor/duraklatıldı, tps, görüntüleyici adresi, dolu alan, blok sayısı |
| `list_blocks` | Bloklar, özellikler, yön kuralları |
| `set_blocks`, `fill` | Oyuncu gibi ya da `/setblock` gibi blok koyar ve kırar |
| `view_region` | Katman katman metin haritası |
| `inspect` | Tek blok: durum, güç, bekleyen tick'ler, gelen sinyaller |
| `interact` | Şalter, buton, kapı, nota bloğu, repeater gecikmesi, comparator modu, varil sinyali, konteyner eşyaları (`set_items`) |
| `run_ticks` | Belirli sayıda tick çalıştırır, problardan dalga formu ve kenar listesi döner |
| `sim_control` | Duraklat, devam et, adım at, tps ayarla, geri sar |
| `chunk_control` | Chunk dondur/çöz, sunucu restart'ı |
| `clear_world` | Baştan başla |
| `save_design`, `load_design`, `list_designs` | `designs/` klasörüne kaydeder ve yükler |
| `export_mcfunction` | Gerçek Minecraft için `/setblock` komutları üretir |
| `export_litematic`, `import_litematic` | Dünyayı (ya da bir bölgesini) `designs/` içine Litematica şeması olarak kaydeder, şema açar |
| `material_list` | Bir yapının (ya da bir bölgesinin) gerektirdiği eşyalar, stack ve shulker sayıları |

## Sunucu koşulları: restart ve unload edilmiş chunk'lar

`World.simulateRestart()` ve `World.frozenChunks` bir sunucunun makineye yaptıklarını taklit
eder:

- **Restart:** kuyruktaki blok olayları kaybolur (MC-89146); zamanlanmış tick'ler ve hareket
  eden pistonlar kaydedilir. Gerçek bir 26.1.2 sunucusunda ölçüldü (kayıttan donmuş açılıp tick
  tick ilerletildi, aynı kayıt simülatörde karşılaştırıldı): hareket eden pistonlar kayıttaki
  bir önceki tick'in ilerlemesiyle gelir, kaydedilmiş zamanlanmış tick'ler bir tick erken
  çalışır.
- **Donmuş chunk:** lazy ya da unload edilmiş chunk; zamanlanmış tick, blok olayı ve hareket
  eden piston çalışmaz.

`scripts/restart-test.js` iki yönlü bir flying machine'i döngüsünün her tick'inde restart eder
(ya da önündeki chunk'ı dondurur, iki chunk'ını sırayla yükler) ve kaç kez uçmaya devam
ettiğini, durduğunu ya da parçalandığını sayar.

## Gerçek dünyadan okuma

`scripts/mc-world.js` gerçek bir Java dünyasının bölge dosyalarından blokları, blok
varlıklarını, hareket eden pistonları ve bekleyen tick'leri okuyup simülatör tasarımına çevirir:

```bash
node scripts/mc-world.js <dünya klasörü> x0 z0 x1 z1 [y0 y1] --save benim-yapim
```

## Doğruluk

Motor, [tickwright](https://github.com/httptim/tickwright) projesinin (Apache-2.0 OR MIT)
gerçek Minecraft 26.3'te kaydettiği blok değişikliği izleriyle karşılaştırılır. Her fixture 8
yönde (4 dönüş ve aynalanmış halleri) koşulur ve üç seviyede kıyaslanır:

- `state`: her tick sonunda her bloğun durumu
- `phase`: her bloğun bir tick içindeki değişiklikleri ve hangi tick fazında oldukları
- `order`: her blok değişikliği, komşu ve shape update'i, zamanlanmış tick ve blok olayı,
  oyundaki sırasıyla

**Desteklenen bloklarla kurulmuş 928 kaydın hepsi üç seviyede de eşleşiyor** (çalıştırıcı
`ran 928 traces, skipped 1311 (unsupported)` yazar). Bunlara konuma bağlı toz, QC/BUD, 0-tick,
blok düşürme, update skipping, meşale yanması, flying machine, piston kapıları, hopper
zincirleri, konteyner okuyan comparator'lar, nota blokları ve kapılar dahil. Atlanan
kayıtlar simülatörde henüz olmayan bir şey kullanıyor: çoğu entity (796), redstone deneyleri
(112) ve su akışı (80), kalanı sculk sensör, crafter, kompostlayıcı, ray gibi bloklar ya da özel
dispenser eşyaları.

Kayıtlar konteyner içeriklerini de tutar; `--items` bunları da karşılaştırır (oyunun rastgele
tohumuna bağlı rastgele slot seçen bir dispenser kaydı dışında hepsi eşleşiyor).

Kaydı olmayan iki davranış var: desteği kalkan tozun ve repeater/comparator'ın shape update
anında kırılması. Bunlar Pumpkin'in 26.3 portuna ve vanilla 1.21.2+ koduna göre uygulandı.

```bash
node scripts/fetch-tickwright.js      # kayıtları vendor/tickwright içine indirir (~14 MB)
node conformance/run.js --verbose     # özet ve ilk farklılıklar
```

İndirme scripti 928/928 sonucunun ölçüldüğü tickwright commit'ine sabitlenmiştir.

## Testler

```bash
npm test
```

Birim testleri bilinen zamanlamaları kontrol eder (repeater gecikmeleri, lamba 4 gt, meşale
yanması, observer, piston zamanlaması, QC/BUD, yapışkan piston blok düşürme, 12 blok sınırı,
hopper, sandık, dropper, nota bloğu, kapı, geri sarma),
ayrıca MCP sunucusunu uçtan uca ve tüm uyumluluk kayıtlarını test eder (kayıtlar indirilmemişse
bu test atlanır).

## Teşekkürler

- [tickwright](https://github.com/httptim/tickwright): uyumluluk testlerindeki gerçek oyun kayıtları.
- [Pumpkin](https://github.com/Pumpkin-MC/Pumpkin): kaydı olmayan iki davranış için kaynak.
- Görüntüleyici için [three.js](https://threejs.org/), sunucu için
  [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Lisans

MIT, bkz. [LICENSE](LICENSE). `scripts/fetch-tickwright.js` ile indirilen tickwright kayıtları
kendi lisanslarıyla gelir (Apache-2.0 OR MIT).

Resmî bir Minecraft ürünü değildir. Mojang ya da Microsoft tarafından onaylanmamıştır ve onlarla
bağlantılı değildir.
