<h1 align="center">پنل BPB</h1>

#### 🌏 Readme in [English](README.md)

> **فورک [پنل BPB](https://github.com/bia-pain-bache/BPB-Worker-Panel)** — در سال ۲۰۲۶ تغییر یافته و توسط [Nexuspt753](https://github.com/Nexuspt753) در [Nexuspt753/BPB-Worker-Panel](https://github.com/Nexuspt753/BPB-Worker-Panel) نگهداری می‌شود. تحت مجوز [GPL-3.0](LICENSE) منتشر می‌شود.

<p align="center">
  <a href="https://nexuspt753.github.io/BPB-Worker-Panel/">
    <img src="https://img.shields.io/github/deployments/Nexuspt753/BPB-Worker-Panel/github-pages?label=docs&logo=github&color=2ea44f" alt="Docs">
  </a>
</p>

<p align="center">
  <img src="docs/assets/images/panel-overview.jpg" alt="Panel overview">
</p>
<br>

## معرفی پروژه

این پروژه یه پنل کاربری برای ساخت و مدیریت کانفیگ‌های **رایگان**، **امن** و **خصوصی** **VLESS**، **Trojan** و **Warp** هست که در کنارش یک سرور **DoH** با قابلیت شصی‌سازی ارائه می‌ده که حتی وقتی دامنه‌ها یا سرویس Warp توسط اپراتورها فیلتر شدن، اتصال رو تضمین می‌کنه. این پنل به دو روش **Wrokers** و **Pages** و از طریق [BPB Wizard](https://github.com/bia-pain-bache/BPB-Wizard) راه‌اندازی می‌شه.

🌟 اگه **پنل BPB** براتون مفید بوده، با حمایتتون بهم دلگرمی می‌دید 🌟

### USDT (BEP20)

```text
0xbdf15d41C56f861f25b2b11C835bd45dfD5b792F
```

## ویژگی‌ها

- **رایگان و شخصی**: بدون هیچ هزینه‌ای، سرور شما شخصی هست.
- **پنل کاربری ساده**: کار باهاش راحته و تنظیمات و استفاده ازش خیلی آسونه.
- **پروتکل‌های متنوع**: ارائه کانفیگ‌های VLESS، Trojan و Wireguard (Warp).
- **سرور DoH شخصی**: یک DoH شخصی با قابلیت تنظیم DNS زیرینایی.
- **کانفیگ‌های Warp Pro**: کانفیگ‌های Warp بهینه‌شده برای شرایط خاص ایران.
- **پشتیبانی از Fragment**: اتصال حتی در صورت فیلتر شدن دامنه.
- **قوانین مسیریابی کامل**: دور زدن سایت‌های ایرانی، چینی و روسی، مسدود کردن QUIC، محتوای پورن، تبلیغات، بدافزارها، فیشینگ و در زدن سایت‌های تحریمی.
- **زنجیره‌ی Proxy**: می‌تونید یه Proxy زنجیره‌ای از نوع VLESS، Trojan، Shadowsocks، Socks یا http اضافه کنید تا IP ثابت بشه.
- **پشتیبانی از برنامه‌های مختلف**: لینک‌های اشتراک برای برنامه‌های با هسته‌های Xray، Sing-box و Clash-Mihomo.
- **پنل امن با رمز عبور**: پنل محافظت شده با لاگین امن.
- **سفارشی‌سازی کامل**: تنظیم IP تمیز، Proxy IP، سرورهای DNS، انتخاب پورت‌ها و پروتکل‌ها، Warp Endpoint و خیلی امکانات دیگه.
- **تبدیل شدن به گره**: قابلیت به اشتراک‌گذاری تنظیمات پنل با دیگر کاربران BPB.
- **تجمیع پروکسی**: قابلیت تجمیع پروکسی‌های شخصی با کانفیگ‌های BPB و تحویل در یک لینک اشتراک.

## محدودیت‌ها

- **اتصال UDP**: پروتکل‌های VLESS و Trojan روی Workerها نمی‌تونن UDP رو به‌خوبی پشتیبانی کنن، برای همین به‌صورت پیش‌فرض غیرفعاله (این روی امکاناتی مثل تماس تصویری تلگرام تأثیر می‌ذاره). DNSهای UDP هم پشتیبانی نمی‌شن. به جاش DoH فعاله که امن‌تره.
- **محدودیت تعداد درخواست**: هر Worker برای VLESS و Trojan روزانه 100 هزار درخواست پشتیبانی می‌کنه، که برای 2-3 نفر کافیه. برای اتصال نامحدود می‌تونید از کانفیگ‌های Warp استفاده کنید.

## شروع به کار

- [روش‌های راه‌اندازی](https://nexuspt753.github.io/BPB-Worker-Panel/fa/wizard/)
- [راهنمای تنظیمات](https://nexuspt753.github.io/BPB-Worker-Panel/fa/configuration/)
- [نحوه‌ی استفاده](https://nexuspt753.github.io/BPB-Worker-Panel/fa/usage/)
- [پرسش‌های متداول (FAQ)](https://nexuspt753.github.io/BPB-Worker-Panel/en/faq/)

## 🚀 نصب این فورک

1. **پنل BPB رو با [BPB Wizard](https://wizard.bpb-panel.workers.dev) نصب کنید** — ویزارد ورکر، KV namespace و اطلاعات ورود پنل شما رو در چند ثانیه می‌سازه.
2. **به بیلد این فورک سوئیچ کنید** — `worker.js` ما رو از [آخرین نسخه](https://github.com/Nexuspt753/BPB-Worker-Panel/releases/latest/download/worker.js) دانلود کنید. بعد توی **Cloudflare Dashboard → ورکر خودتون → Edit code**، خط `const EMBEDED_SETTINGS = {...};` بالای فایل رو کپی کنید، همه‌چیز بعدش رو با فایل دانلودشده جایگزین کنید و **Deploy** بزنید.

پنل شما حالا نسخهٔ این فورک رو اجرا می‌کنه (قالب‌های اسم کانفیگ، تست آنلاین Chain Proxy، واردکردن یک‌کلیک) در حالی که ورکر، KV namespace و مسیر امن ساخته‌شده توسط ویزارد همون‌طور استفاده می‌شه.

## برنامه‌های پشتیبانی شده

<div dir="rtl">

|       برنامه        | حداقل نسخه | پشتیبانی از Fragment | پشتیبانی از Warp Pro |
| :-----------------: | :--------: | :------------------: | :------------------: |
|     **v2rayNG**     |   2.2.3    |  :heavy_check_mark:  |  :heavy_check_mark:  |
|     **MahsaNG**     |     16     |  :heavy_check_mark:  |  :heavy_check_mark:  |
|     **v2rayN**      |   7.22.5   |  :heavy_check_mark:  |  :heavy_check_mark:  |
|    **Streisand**    |   1.6.71   |  :heavy_check_mark:  |  :heavy_check_mark:  |
|    **Sing-box**     |   1.12.0   |  :heavy_check_mark:  |         :x:          |
|      **husi**       |   1.3.2    |  :heavy_check_mark:  |         :x:          |
|   **Clash Meta**    |            |         :x:          |  :heavy_check_mark:  |
| **Clash Verge Rev** |            |         :x:          |  :heavy_check_mark:  |
|     **FLClash**     |            |         :x:          |  :heavy_check_mark:  |
|    **Wireguard**    |            |         :x:          |         :x:          |
|   **AmneziaVPN**    |            |         :x:          |  :heavy_check_mark:  |
|    **WG Tunnel**    |            |         :x:          |  :heavy_check_mark:  |

</div>

---

### تشکر ویژه

- توسعه‌دهنده پروژه [پروکسی Cloudflare-workers/pages](https://github.com/yonggekkk/Cloudflare-workers-pages-vless)
- توسعه‌دهنده پروژه CF-vless [3Kmfi6HP](https://github.com/3Kmfi6HP/EDtunnel)
- توسعه‌دهنده پروژه IP ترجیحی کلادفلر [badafans](https://github.com/badafans/Cloudflare-IP-SpeedTest)، [XIU2](https://github.com/XIU2/CloudflareSpeedTest)
