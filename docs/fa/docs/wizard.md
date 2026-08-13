# :material-new-box:{ .md .middle } راه‌اندازی خودکار با BPB Wizard

برای ساده‌تر کردن فرآیند راه‌اندازی و جلوگیری از اشتباهات کاربرها، پروژه [BPB Wizard](https://github.com/bia-pain-bache/BPB-Wizard) در دو نسخه تحت وب و ترمینال برای سیستم‌عامل‌های مختلف راه‌اندازی شده. این ابزار از هر دو روش Workers و Pages پشتیبانی می‌کنه و فقط چند ثانیه زمان می‌بره تا پنل رو نصب کنه.

<p align="center" class="img-wrapper">
  <img src="/BPB-Worker-Panel/images/wizard-web.jpg" width="400" alt="wizard-web" />
  <img src="/BPB-Worker-Panel/images/wizard-cli.jpg" width="400" alt="wizard-cli" />
</p>

## ۱. حساب Cloudflare

برای استفاده از این روش، فقط به یه حساب Cloudflare نیاز دارید. می‌تونید [از اینجا ثبت‌نام کنید](https://dash.cloudflare.com/sign-up/). بعدش یادتون نره ایمیلتون رو چک کنید تا حساب رو تأیید کنید.

## ۲. نصب پنل BPB

### نسخه تحت وب

این نسخه بدون تنظیمات خاصی قابل استفاده هست، با توجه به مراحل ذکر شده در صفحه یه Token می‌سازید و پنل رو نصب می‌کنید.

بعد از اولین نصب هم بهتون یه `Private Link` میده که قابلیت نصب تک کلیک رو روی اکانتتون فعال می‌کنه.

```url title="نصب آنلاین"
https://wizard.bpb-panel.workers.dev
```

### نسخه ترمینال

```bash title="Windows PowerShell"
irm https://raw.githubusercontent.com/bia-pain-bache/BPB-Wizard/main/install.ps1 | iex
```

```bash title="Android (Termux) - Linux - macOS"
bash <(curl -fsSL https://raw.githubusercontent.com/bia-pain-bache/BPB-Wizard/main/install.sh)
```

!!! warning "توصیه‌های استفاده از Termux"
    حتماً Termux رو از [منبع رسمی](https://github.com/termux/termux-app/releases/latest) دانلود و نصب کنید. نصب از گوگل پلی ممکنه مشکلاتی ایجاد کنه. ترجیحا قبل از اجرا فیلترشکن رو قطع کنید.

## ۳. تعویض با نسخهٔ این فورک

ویزارد، **پنل BPB اصلی** رو نصب می‌کنه. برای اجرای نسخهٔ این فورک (قالب‌های اسم کانفیگ، تست آنلاین Chain Proxy، واردکردن یک‌کلیک)، `worker.js` نصب‌شده رو با نسخهٔ ما جایگزین کنید — تنظیمات شما دست‌نخورده می‌مونه:

1. `worker.js` ما رو از آخرین نسخه دانلود کنید:

   ```url title="آخرین بیلد فورک"
   https://github.com/Nexuspt753/BPB-Worker-Panel/releases/latest/download/worker.js
   ```

2. وارد **Cloudflare Dashboard** → **Workers & Pages** → ورکر خودتون → **Edit code** بشید.

3. در ابتدای فایل `const EMBEDED_SETTINGS = {...};` رو می‌بینید — **کل این عبارت رو کپی کنید** (از `const` تا `};` بسته‌شونده). حساب Cloudflare، UUID و رمز پنل شما داخلشه؛ گمش نکنید.

4. بقیهٔ کد رو انتخاب و حذف کنید، بعد عبارت `const EMBEDED_SETTINGS = {...};` و سپس کل محتوای `worker.js` دانلودشده رو paste کنید.

5. **Deploy** بزنید و دوباره آدرس پنلتون رو باز کنید.

پنل شما حالا نسخهٔ این فورک رو اجرا می‌کنه — ورکر، KV namespace و مسیر امن ساخته‌شده توسط ویزارد همون‌طور که هست استفاده می‌شه.
