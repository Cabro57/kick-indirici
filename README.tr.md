<div align="center">

<img src="assets/logo-1024.png" alt="Kick İndirici" width="128">

# Kick İndirici

[English](README.md) · **Türkçe**

**Kick yayınlarını, kliplerini ve canlı yayınlarını hattın izin verdiği hızla indir.**
İzle, içinden istediğin anı kes, canlıyı kaydet. Hepsi tek pencerede.

![Sürüm](https://img.shields.io/badge/sürüm-1.0.0-53FC18?style=flat-square&labelColor=0b0e0f)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-53FC18?style=flat-square&labelColor=0b0e0f)
![Python](https://img.shields.io/badge/Python-3-53FC18?style=flat-square&labelColor=0b0e0f)

<br>

<img src="docs/img/kanal.jpg" alt="Bir yayıncının sayfası: canlı yayın şeridi ve yayın ızgarası" width="900">

</div>

<br>

## İçindekiler

[Neler yapar](#neler-yapar) · [Kurulum](#kurulum) · [Nasıl kullanılır](#nasıl-kullanılır) · [Kısayollar](#kısayollar) · [Ayarlar ve dosyalar](#ayarlar-ve-dosyalar) · [Sorun giderme](#sorun-giderme) · [Gizlilik](#gizlilik) · [Geliştirme](#geliştirme)

<br>

## Neler yapar

### Yayıncıyı aç, hepsini bir bakışta gör

Üstteki kutuya kanal adını ya da bir **kanal / yayın / klip linkini** yapıştır. Yayınlar ve klipler küçük resimleriyle gelir. Kartın üzerine gelince önizleme sessizce oynar, kartı tıklayınca büyük pencerede açılır.

Yayıncı **canlıysa**, listenin en üstünde tam genişlikte bir **canlı şeridi** çıkar: canlı önizleme, başlık, izleyici sayısı ve iki düğme (**Kaydı başlat**, **Kesit al**).

<img src="docs/img/canli-seridi.jpg" alt="Canlı yayın şeridi: önizleme oynuyor" width="900">

<table>
<tr>
<td width="50%" valign="top">

**Üzerine gelince önizleme**

Kartın üzerinde bekleyince video sessizce oynar. Tıkladığında izleme penceresi aynı andan devam eder.

<img src="docs/img/onizleme.jpg" alt="Kartın üzerinde oynayan önizleme ve yükleme halkası">

</td>
<td width="50%" valign="top">

**Favori yayıncılar**

Yıldıza basınca yayıncı soldaki şeride eklenir. Canlıya geçince yeşil halka yanar, yeni yayın gelince sayısı görünür. İstersen yeni yayınlar kendiliğinden iner, canlıya geçince kayıt kendiliğinden başlar.

<img src="docs/img/ana-sayfa.jpg" alt="Ana sayfa: favori yayıncılar ve son indirilenler">

</td>
</tr>
</table>

<br>

### Ortada büyük pencerede izle

Bir videoya tıkla: karartılmış bir arka plan üstünde büyük bir pencere açılır. Sağ tarafta **kalite seçimi** ve işlemler durur: *Tamamını indir*, *Kesit al*, *Sohbeti indir*.

**← →** tuşları ya da kenarlardaki oklar bir önceki / sonraki videoya geçer. **Esc** kapatır ve videoyu durdurur.

**Sohbet** videonun yanında, oynatmayla eşzamanlı akar: yayın geçmişlerinde, kliplerde, canlı yayında ve indirilen dosyalarda (oynatıcı çubuğundaki sohbet düğmesi gizler). Geriye okumak için yukarı kaydır; *Şimdiye dön* yeniden videoyu takip eder. Saate tıklayınca video o ana gider. Mesajlara tıklayıp seç (**Shift** ile aralık), sonra **Kopyala** ya da **Kaydet** ile PNG resmi al; dişli düğmesi arka planı (koyu / saydam), genişliği ve saat, rozet, emote çizilip çizilmeyeceğini ayarlar. Kesit editöründe aynı sohbet *Sohbet* sekmesinde.

**Sohbet videosu:** sohbet ayrı, akan bir video olarak da hazırlanabilir; düzenleyicide yayının yanına koymak için (yayın videosunun üstüne gömülmez). Yeşil perde, yeşili silinecek bir `.mp4` verir; saydam, saydamlığı olan bir `.webm` verir (Premiere, DaVinci Resolve, OBS). Ölçü, yazı boyutu ve saat, rozet, emote gösterilip gösterilmeyeceği Ayarlar → Sohbet'te. Üç yoldan yapılır: sohbet dosya türlerinde *Video*yu seç (her sohbet indirmesiyle hazırlanır), İndirilenler'deki bir sohbette *Sohbet videosu oluştur*, ya da sohbet panelinde seçilen mesajların altındaki film düğmesi (yalnızca o mesajların kısa videosu). Yoğun sohbetin saati yaklaşık 4 dakika sürer.

<img src="docs/img/izleme-penceresi.jpg" alt="Ortada açılan izleme penceresi" width="900">

<br>

### Çok sayıda videoyu seç, tek tıkla indir

Kartın köşesindeki kutuya (ya da **Ctrl+tık**) basınca seçim başlar. Seçim varken düz tık seçime ekler / çıkarır; izlemek istersen kartın ortasındaki **▶** düğmesini kullan. **Shift+tık** aradakileri seçer.

Altta bir çubuk belirir: kaç video seçtiğin, **toplam süre**, kalite ve **İndir (n)**. Sayıya tıklarsan seçtiklerin listelenir, her birini tek tek çıkarabilirsin.

<img src="docs/img/secim.jpg" alt="Seçim çubuğu ve seçilenlerin listesi" width="900">

<br>

### Her kartta ⋮ menüsü

Başlığın yanındaki **⋮** düğmesi ya da **sağ tık**. Menü videonun durumuna göre değişir: henüz inmediyse *İndir*, iniyorsa *Durdur*, durmuşsa *Devam ettir*, inmişse *Oynat* ve *Klasörde göster*. Ayrıca *Kesit al*, *Sohbeti indir*, *Kick'te aç* ve *Linki kopyala*.

<img src="docs/img/kart-menusu.jpg" alt="Kartın üç nokta menüsü" width="900">

<br>

### Yayının içinden istediğin anı kes

**Kesit al** ile video editörü gibi bir pencere açılır: yakınlaştırılabilir zaman çizelgesi (kare şeridi ve ses dalgası), üzerine gelince kare önizleme, sürükleyerek gezinme, **0,25× – 4×** oynatma hızı.

- **K** ile playhead'in çevresine otomatik uzunlukta kesit eklenir. Kenarları sürükleyerek ya da saat yazarak ayarlarsın.
- Kesitler **ayrı dosyalar** ya da **tek video** olarak iner.
- Yalnızca o aralığı kapsayan parçalar indirilir. 4 saatlik yayından 30 saniyelik kesit için 4 saatlik veri çekilmez.
- Canlı yayından da kesit alabilirsin: yayın sürerken geçmişe dönüp istediğin anı kes.

<img src="docs/img/kesit-editoru.jpg" alt="Kesit editörü: zaman çizelgesi ve kesit listesi" width="900">

<br>

### İndirmeler: hızlı, okunaklı, kaldığı yerden devam eder

<table>
<tr>
<td width="50%" valign="top">

**Sırada ve inenler**

Kartlar üzerinde durum görünür (*İniyor %37*, *Sırada*, *İndirildi*). Alt çubuk toplam ilerlemeyi, kalan süreyi, hızı ve diskteki boş yeri gösterir.

<img src="docs/img/indirme.jpg" alt="İniyor durumundaki kartlar ve alt çubuk">

</td>
<td width="50%" valign="top">

**İndirilenler**

Bitenler güne göre gruplanır. Dosya uygulamanın içinde oynar, Windows oynatıcısında açılır, klasörde gösterilir ya da Geri Dönüşüm Kutusu'na gönderilir.

<img src="docs/img/indirilenler.jpg" alt="İndirilenler listesi">

</td>
</tr>
</table>

### Daha neler var

| | |
|---|---|
| **Hız ayarı gerektirmez** | Aynı anda kaç video ineceğini (1–6) program, toplam hızı ölçerek kendisi ayarlar. Her video parçalarını 8–32 bağlantıyla çeker. |
| **Hız sınırı** | Oyun ya da yayın izlerken hattı doldurmasın diye toplam hıza üst sınır koyabilirsin. |
| **Canlı kayıt** | Canlı yayını şu andan itibaren kaydeder. Bitince `.ts` dosyası `.mp4`'e çevrilir. |
| **Sohbeti indir** | VOD'un sohbetini `.ass` altyazı (VLC / MPC videonun üstünde akıtır) ve `.chat.json` olarak kaydeder. |
| **Kaldığı yerden devam** | Program kapanırsa yarım kalanlar bir sonraki açılışta *Devam et* ile sürer. |
| **Disk koruması** | İndirmeden önce boş yer kontrol edilir. Sığmayan indirme açık bir mesajla başarısız olur, kuyruğun geri kalanı sürer. |
| **Bitince** | Kuyruk bitince hiçbir şey yapma, uykuya al ya da bilgisayarı kapat (60 sn geri sayım, iptal edilebilir). |
| **Pano ve sürükle-bırak** | Panoda Kick linki varsa pencereye dönünce önerir. Tarayıcıdan linki pencereye bırakabilir ya da Ctrl+V ile yapıştırabilirsin. |
| **Windows bildirimleri** | Kuyruk bitince ve favorin canlıya geçince bildirim. İkisi de ayarlardan kapatılır. |
| **Dosya adı şablonu** | `{channel} - {title} [{id}]` gibi: `{channel}` `{title}` `{date}` `{id}` kullanılabilir. Eski `{kanal}` `{baslik}` `{tarih}` adları da çalışır. |
| **Arayüz dili** | Türkçe ve İngilizce. İlk açılışta Windows diline göre seçilir; Ayarlar → Uygulama → Dil ile değişir. |
| **Tek örnek** | Program zaten açıksa ikinci kez açmak mevcut pencereyi öne getirir. |
| **Güncelleme denetimi** | Açılışta GitHub'daki son sürümü denetler, yenisi varsa şeritte haber verir. |

<br>

## Kurulum

### Tek tıkla kurulum (önerilen)

1. [**Releases**](https://github.com/Cabro57/kick-indirici/releases/latest) sayfasından **`KickIndirici-Setup-….exe`** dosyasını indir.
2. Aç ve **Kur**'a bas. Yönetici izni gerekmez, `ffmpeg` içinde hazır gelir. Yeni sürümler program içinden **Güncelle ve yeniden başlat** ile kendiliğinden kurulur.

Kurulumsuz kullanmak için `KickIndirici-…-windows.zip`'i bir klasöre çıkar ve **`KickIndirici.exe`**'yi aç. `ffmpeg.exe` exe'nin yanında durmalı.

> ffmpeg olmadan videolar iner ama kesit, canlı kayıt ve son mp4 düzeltmesi çalışmaz. Kaynaktan çalıştırıyorsan ffmpeg'i kendin kur: `winget install Gyan.FFmpeg`, ya da [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) üzerinden "release essentials".

### Gereksinimler

| | |
|---|---|
| **İşletim sistemi** | Windows 10 ya da 11 |
| **WebView2 Runtime** | Windows 11'de hazır gelir. Yoksa program açılışta indirme sayfasını önerir. |
| **.NET Framework 4.6.2+** | Windows'ta hazır gelir. |
| **ffmpeg** | Kesit, canlı kayıt ve mp4 düzeltmesi için (zip'te hazır) |

### Kaynaktan çalıştır

```bash
git clone https://github.com/Cabro57/kick-indirici-src.git
cd kick-indirici-src
pip install -r requirements.txt
python kick_indir.py
```

`baslat.bat` da aynı şeyi konsol penceresi açmadan yapar.

<br>

## Nasıl kullanılır

1. **Aç.** Üstteki kutuya `kick.com/xqc`, sadece `xqc`, bir yayın linki ya da bir klip linki yaz. Klip linki doğrudan indirmeye gider.
2. **Seç.** Yayınlar sekmesinde videoya tıkla ve izle, ya da kartların köşesindeki kutularla çoklu seç.
3. **İndir.** *Tamamını indir*, *Klibi indir* ya da *Kesit al*. Gerisini program halleder.
4. **Bul.** *İndirilenler* düğmesi (Ctrl+J) bitenleri gösterir. Dosyalar varsayılan olarak `Kullanıcı\İndirilenler\Kick` klasörüne gider.

> **İpucu:** Yayının neresinde ne olduğunu bakmak için kartın üzerinde bekle. Uzun yayınlarda önizleme baştan değil, yaklaşık %20'sinden başlar.

<br>

## Kısayollar

Listeyi uygulamada **?** tuşuyla da görebilirsin.

<table>
<tr>
<td valign="top" width="50%">

**Genel**

| Tuş | İş |
|---|---|
| `Ctrl` `L` | Link kutusuna git |
| `Ctrl` `V` | Linki yapıştırıp aç |
| `Ctrl` `J` | İndirilenler |
| `?` | Kısayol listesi |

**Videolar**

| Tuş | İş |
|---|---|
| Tık | İzle (seçim varken: seçime ekle / çıkar) |
| `Ctrl` tık · `Boşluk` | Seçime ekle / çıkar |
| `Shift` tık | Aradakileri seç |
| `Ctrl` `A` | Tümünü seç |
| `Esc` | Seçimi bırak |

</td>
<td valign="top" width="50%">

**Oynatıcı**

| Tuş | İş |
|---|---|
| `K` | Oynat / durdur |
| `M` | Sesi kapat / aç |
| `F` | Tam ekran |
| `←` `→` | Önceki / sonraki video |
| `Esc` | Kapat |

**Kesit editörü**

| Tuş | İş |
|---|---|
| `K` | Kesit ekle |
| `I` / `O` | Giriş / çıkış noktası |

Editördeki tüm kısayollar sağ üstteki **Kısayollar** düğmesinde.

</td>
</tr>
</table>

<div align="center">
<img src="docs/img/kisayollar.jpg" alt="Kısayol listesi" width="760">
</div>

<br>

## Ayarlar ve dosyalar

<table>
<tr>
<td width="55%" valign="top">

Ayarlar sol alttaki dişli ile açılır: arayüz dili, indirme klasörü, varsayılan kalite, dosya adı şablonu, aynı anda inen video sayısı, video başına bağlantı, hız sınırı, önizleme ve oynatıcı davranışı, bildirimler, varsayılan kesit uzunluğu ve güncelleme denetimi.

**Kalite:** En iyi · 1080p60 · 720p60 · 480p · 360p · 160p. İstenen kalite yoksa en yakın düşük kalite iner.

</td>
<td width="45%" valign="top">

<img src="docs/img/ayarlar.jpg" alt="Ayarlar sayfası">

</td>
</tr>
</table>

Program verisini şurada tutar: `%APPDATA%\KickIndirici\`

| Dosya | İçerik |
|---|---|
| `settings.json` | Ayarlar ve favori yayıncılar |
| `history.json` | İndirilenler geçmişi |
| `queue.json` | Yarım kalan indirmeler |
| `log.txt` | Hata ayıklama günlüğü |

<br>

## Sorun giderme

<details>
<summary><b>Pencere siyah açılıyor</b></summary>

<br>

WebView2 Runtime eksik ya da bozuk olabilir. Program açılışta bunu denetler ve indirme sayfasını önerir. "Zaten kurulu" diyorsa önce *Uygulamalar* bölümünden WebView2 Runtime'ı kaldırıp bağımsız kurucuyla yeniden kur.

Windows 10'da bazı ekran kartı sürücüleri WebView2'yi siyah çizer. Program bu durumda GPU'yu kendiliğinden kapatır; elle seçmek için `--gpu` / `--no-gpu` parametreleri var.

</details>

<details>
<summary><b>"ffmpeg bulunamadı" uyarısı</b></summary>

<br>

`ffmpeg.exe` dosyasını `KickIndirici.exe`'nin yanına koy ya da PATH'e ekle. Terminalde `ffmpeg -version` çalışıyorsa program da bulur.

</details>

<details>
<summary><b>İndirme "403" ile başarısız oluyor</b></summary>

<br>

Kick erişimi reddetti. Tekrar dene; sürerse video silinmiş ya da abonelere özel olabilir.

</details>

<details>
<summary><b>Canlı kayıt <code>.ts</code> olarak kaldı</b></summary>

<br>

Ayarlarda *Canlı kaydı mp4'e çevir* kapalıdır. Uygulamanın oynatıcısı `.ts` açamaz; Windows oynatıcısında aç ya da ayarı aç.

</details>

<details>
<summary><b>Bir şey ters gidiyor</b></summary>

<br>

`%APPDATA%\KickIndirici\log.txt` dosyasına bak. Kaynaktan çalıştırırken `python kick_indir.py --debug` geliştirici araçlarını açar.

</details>

<br>

## Gizlilik

Uygulama, **anonim kullanım verisi** gönderip gönderemeyeceğini bir kez kurulumda, bir kez de ilk açılışta sorar. Cevap verene kadar hiçbir şey gönderilmez; *Hayır* dersen hiç gönderilmez. İstediğin zaman **Ayarlar → Uygulama → Anonim kullanım verisi gönder**'den değiştirebilirsin (*Ne gönderiliyor?* tam listeyi gösterir).

**Gönderilenler:** uygulama sürümü, Windows sürümü ve dil; bilgisayarında üretilen rastgele bir kurulum kimliği (seninle ilişkisi yok); donanım (işlemci, çekirdek sayısı, bellek, ekran kartı, ekran, indirme klasörünün SSD mi HDD mi olduğu); her indirme için türü, **kanal adı**, boyutu, süresi, hızı ve indirme ayarları; hangi özelliklerin kullanıldığı (kesit editörü, sohbet paneli, sohbet videosu, canlı kayıt…); hatalar (hata türü ve kodda nerede olduğu; klasörler ve kullanıcı adın çıkarılır).

**Asla gönderilmeyenler:** IP adresin (saklanmaz), video linkleri ya da başlıkları, dosya adları ya da klasörler, Windows kullanıcı adın, yazdığın hiçbir şey.

Veriler [PostHog](https://posthog.com)'un AB'deki sunucularına gider ve yalnızca kaç kişinin hangi sürümü kullandığını, indirmelerin gerçek bağlantılarda ne hızda olduğunu ve önce hangi hataların düzeltileceğini görmek için kullanılır.

## Geliştirme

Arayüz HTML / CSS / JS (`web/`), motor Python. Pencereyi **pywebview** (Edge WebView2) çizer; indirme `yt-dlp`, ağ istekleri `curl_cffi`, kesme ve birleştirme `ffmpeg` ile yapılır.

```
kick_indir.py     Giriş noktası (src/ klasörünü yola ekleyip kickindir.app.main'i çağırır)
src/kickindir/    Python motoru
  config.py         Sabitler, dosya yolları, uygulama klasörleri
  app.py            Pencere, tek kopya denetimi, main()
  api/              Arayüze açılan Api: __init__.py birleştirir; general, updates, queue_control,
                    workers, library, favorites, cuts, browse parçalarından oluşur
  services/         kick (Kick API'si), chat (sohbet), media (önizleme, medya sunucusu), notify (bildirim),
                    updater (manifest'e göre dosya güncelleme)
  core/             engine (hız sınırlayıcı, indirme kaydı), storage (ayarlar, kuyruk, geçmiş), prefs, util
web/              Arayüz (index.html, app.css, app.js, i18n.js, vendor/ içinde hls.js)
  i18n/             Dil dosyaları: en.json (asıl kaynak), tr.json
assets/           Logo ve uygulama ikonu
tools/make_logo.py  Logo ve ikonu üreten betik
tools/make_manifest.py  Sürümün manifest.json'unu üreten betik
tools/check_i18n.py  Dil dosyalarını denetler (eksik anahtar, farklı yer tutucu)
tools/screenshots.py  README ekran görüntülerini alır: python tools/screenshots.py tr <kanal> ... (geçici veri klasörü kullanır, indirme yapmaz)
PRODUCT.md        Ürünün ne yaptığı ve kısıtları
DESIGN.md         Görsel tasarım sistemi
PERF.md           Hız denemeleri ve sonuçları
```

**Arayüz metinleri:** kodda metin yazılmaz, anahtar kullanılır: JS'te `t("anahtar", { n })`, HTML'de `data-i18n="anahtar"`, Python'da `t("anahtar", n=1)`. Yeni anahtarı hem `web/i18n/en.json`'a hem `tr.json`'a ekle, sonra `python tools/check_i18n.py` çalıştır. İngilizcede çoğul için değer `{"one": "…", "other": "…"}` olabilir. Yeni dil için `web/i18n/<kod>.json` ekle ve `src/kickindir/core/i18n.py` içindeki `LANGS`'a yaz.

**Tek dosyalık exe derlemek:**

```bash
exe_yap.bat
# ya da
python -m PyInstaller --noconfirm KickIndirici.spec
```

Çıktı `dist\KickIndirici.exe`. Kurucuyu (`dist\KickIndirici-Setup-<sürüm>.exe`) [Inno Setup 6](https://jrsoftware.org/isinfo.php) ile `ISCC /DAppVersion=1.0.0 installer\KickIndirici.iss` derler.

**Sürüm çıkarmak:** `src/kickindir/config.py` içindeki `VERSION`'ı artır, commit'le, `git tag v1.0.1 && git push --tags`. `.github/workflows/release.yml` exe'yi, kurucuyu ve zip'i derleyip [kick-indirici](https://github.com/Cabro57/kick-indirici) deposuna sürüm olarak yükler. Uygulama içi güncelleme bu sürümdeki `manifest.json`'a bakar ve yalnızca değişen dosyaları (SHA-256 ile doğrulayarak) indirir; manifest okunamazsa kurucuya döner. Yeni bir dosya eklemek için workflow'daki `make_manifest.py` satırına eklemek yeter. Bunun için bu depoda `RELEASE_TOKEN` secret'ı (kick-indirici'ye *Contents: write* yetkili bir fine-grained token) tanımlı olmalı. Hız denemelerinin kaydı için [PERF.md](PERF.md)'ye bak.

<br>

## Uyarı

Bu program Kick ile bağlantılı değildir ve Kick tarafından onaylanmamıştır. Kişisel kullanım için yazılmıştır: kendi yayınlarını yedeklemek, izin verilen içerikleri arşivlemek gibi. İndirdiğin içeriklerin telif hakkı yayıncılara aittir; Kick'in kullanım koşullarına ve yayıncıların haklarına uymak sana aittir.

*Kick* adı ve "K" simgesi Kick'e aittir. Bu depodaki logo kişisel kullanım içindir; dağıtılan bir sürüm kendi simgesini kullanmalıdır.
