/**
 * ماسح المعرّفات السريع (QR ID Collector PWA)
 * - يعتمد نفس منطق تقييم الكاميرات (_cameraScore) واختيار العدسة الخلفية الرئيسية 1x وتبديل الكاميرا.
 * - يمنع تكرار أي معرّف ممسوح مسبقاً.
 * - يرفض الروابط وأي رمز يحوي نقاط أو فواصل أو @ أو رموز غير الشرطة (-) مع تنبيه فوري.
 */

const App = {
  // حالة الكاميرا والماسح
  html5QrCode: null,
  isScanning: false,
  isStarting: false,
  cameras: [],
  currentCameraId: null,
  preferredCameraId: null,

  // قائمة المعرّفات الممسوحة (مرتبة، وبدون تكرار)
  scannedList: [],
  scannedSet: new Set(),

  // تهدئة التنبيهات المتكررة لنفس الرمز أثناء وقوف الكاميرا عليه
  lastAlertCode: '',
  lastAlertTime: 0,

  // الصوت (Web Audio API بدون ملفات خارجية)
  audioCtx: null,

  // مفاتيح الإعدادات البسيطة (الوضع الليلي/النهاري وخيار الشرطة فقط — لا يحفظ بيانات طلاب)
  MODE_STORAGE_KEY: 'QR_COLLECTOR_THEME_MODE',

  init() {
    this.cacheElements();
    this.restoreThemeMode();
    this.bindEvents();
    this.registerServiceWorker();
    this.renderOutput();
  },

  cacheElements() {
    this.els = {
      btnToggleMode: document.getElementById('btn-toggle-mode'),
      modeIcon: document.getElementById('mode-icon'),
      metaThemeColor: document.getElementById('meta-theme-color'),

      scannerBadge: document.getElementById('scanner-badge'),
      viewportWrap: document.querySelector('.qr-viewport-wrap'),
      qrPlaceholder: document.getElementById('qr-placeholder'),
      statusBar: document.getElementById('qr-status-bar'),

      btnStart: document.getElementById('btn-start-camera'),
      btnSwitch: document.getElementById('btn-switch-camera'),
      btnStop: document.getElementById('btn-stop-camera'),

      statCount: document.getElementById('stat-count'),
      statLastId: document.getElementById('stat-last-id'),

      chkKeepHyphen: document.getElementById('chk-keep-hyphen'),
      chkSound: document.getElementById('chk-sound'),

      outputText: document.getElementById('output-text'),
      charCounter: document.getElementById('char-counter'),

      btnCopy: document.getElementById('btn-copy-text'),
      btnUndo: document.getElementById('btn-undo-last'),
      btnClear: document.getElementById('btn-clear-all'),

      chipsSection: document.getElementById('chips-section'),
      scannedChips: document.getElementById('scanned-chips'),
      toastContainer: document.getElementById('toast-container')
    };
  },

  bindEvents() {
    this.els.btnToggleMode.addEventListener('click', () => this.toggleThemeMode());

    this.els.btnStart.addEventListener('click', () => this.startCamera());
    this.els.btnSwitch.addEventListener('click', () => this.switchCamera());
    this.els.btnStop.addEventListener('click', () => this.stopCamera());

    this.els.chkKeepHyphen.addEventListener('change', () => this.renderOutput());

    this.els.btnCopy.addEventListener('click', () => this.copyAllText());
    this.els.btnUndo.addEventListener('click', () => this.undoLastId());
    this.els.btnClear.addEventListener('click', () => this.clearAllIds());

    // إيقاف الكاميرا عند إخفاء الصفحة للحفاظ على البطارية
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.isScanning) {
        this.stopCamera();
      }
    });
  },

  /* ========================================================================
     الوضع الليلي / النهاري (ثيم صنوبر وفضي Pine & Silver)
     ======================================================================== */
  restoreThemeMode() {
    let mode = 'dark';
    try {
      const saved = localStorage.getItem(this.MODE_STORAGE_KEY);
      if (saved === 'light' || saved === 'dark') mode = saved;
    } catch (_) {}
    this.applyThemeMode(mode);
  },

  toggleThemeMode() {
    const current = document.documentElement.getAttribute('data-mode') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    this.applyThemeMode(next);
    try {
      localStorage.setItem(this.MODE_STORAGE_KEY, next);
    } catch (_) {}
  },

  applyThemeMode(mode) {
    document.documentElement.setAttribute('data-theme', 'pine');
    document.documentElement.setAttribute('data-mode', mode);
    this.els.modeIcon.textContent = mode === 'dark' ? '☀️' : '🌙';
    if (this.els.metaThemeColor) {
      this.els.metaThemeColor.setAttribute('content', mode === 'dark' ? '#14241d' : '#183d2f');
    }
  },

  /* ========================================================================
     تقييم الكاميرات واختيار الخلفية الرئيسية 1x (مطابق للبند 28)
     ======================================================================== */
  _isBackCamera(label) {
    const l = (label || '').toLowerCase();
    return /back|rear|environment|خلف/.test(l);
  },

  _isFrontCamera(label) {
    const l = (label || '').toLowerCase();
    return /front|user|face|facetime|أمام/.test(l);
  },

  _cameraScore(cam) {
    const label = (cam && cam.label ? cam.label : '').toLowerCase();
    let score = 0;

    if (this._isBackCamera(label)) score += 100;
    if (this._isFrontCamera(label)) score -= 100;

    // استبعاد العدسات المساعدة (Ultra-wide, Telephoto, Macro, Depth, Mono, Zoom)
    if (/ultra|wide-angle|0\.5x|tele|macro|depth|mono|infrared|ir|zoom|fisheye/.test(label)) {
      score -= 50;
    }

    // تفضيل الكاميرا الخلفية الرئيسية في iOS
    if (/back camera|rear camera/.test(label)) score += 20;
    if (/dual|triple/.test(label)) score += 10;

    // في أندرويد: camera2 0, facing back هي الرئيسية، وكل رقم أعلى يخصم 5 نقاط
    const m = label.match(/camera2?\s*(\d+)/);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (!isNaN(idx)) score -= idx * 5;
    }

    return score;
  },

  async loadCameras() {
    if (typeof Html5Qrcode === 'undefined') {
      throw new Error('مكتبة المسح الضوئي (html5-qrcode) غير محمّلة.');
    }
    const devices = await Html5Qrcode.getCameras();
    if (!Array.isArray(devices) || devices.length === 0) {
      this.cameras = [];
      return [];
    }

    // ترتيب الكاميرات تنازلياً حسب التقييم (الخلفية الرئيسية أولاً)
    const scored = devices.map((cam, index) => ({
      id: cam.id,
      label: cam.label || `كاميرا ${index + 1}`,
      score: this._cameraScore(cam),
      origIndex: index
    }));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.origIndex - b.origIndex;
    });

    this.cameras = scored;
    return this.cameras;
  },

  _formatCameraStatus(camId) {
    if (!this.cameras.length) return 'الكاميرا نشطة — وجّه العدسة نحو رمز QR';
    const idx = this.cameras.findIndex(c => c.id === camId);
    if (idx === -1) return 'الكاميرا نشطة — وجّه العدسة نحو رمز QR';
    const cam = this.cameras[idx];
    const kind = this._isFrontCamera(cam.label)
      ? 'أمامية'
      : (this._isBackCamera(cam.label) ? 'خلفية' : 'كاميرا');
    return `العدسة النشطة: «${kind} ${idx + 1}/${this.cameras.length} (${cam.label})»`;
  },

  async startCamera(forcedCameraId = null) {
    if (this.isStarting || this.isScanning) return;
    this.isStarting = true;
    this.els.btnStart.disabled = true;
    this.els.statusBar.textContent = 'جاري تهيئة الكاميرا...';

    try {
      await this.loadCameras();

      if (!this.html5QrCode) {
        this.html5QrCode = new Html5Qrcode('qr-reader');
      }

      // تحديد قائمة المحاولات بالترتيب:
      // 1. الكاميرا المحددة قسرياً أو المفضلة في الجلسة أو الأعلى تقييماً (إن وُجدت إشارة خلفية واضحة)
      // 2. { facingMode: "environment" }
      // 3. أول كاميرا متاحة في القائمة
      const candidates = [];
      const targetId = forcedCameraId || this.preferredCameraId || (this.cameras[0] && this.cameras[0].score > 0 ? this.cameras[0].id : null);

      if (targetId) candidates.push(targetId);
      candidates.push({ facingMode: 'environment' });
      if (this.cameras[0] && this.cameras[0].id !== targetId) {
        candidates.push(this.cameras[0].id);
      }

      const config = {
        fps: 20, // سرعة مسح عالية
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
          const size = Math.max(170, Math.min(250, Math.floor(minEdge * 0.75)));
          return { width: size, height: size };
        },
        aspectRatio: 1.0
      };

      let startedWith = null;
      let lastError = null;

      for (const candidate of candidates) {
        try {
          await this.html5QrCode.start(
            candidate,
            config,
            (decodedText) => this.onScanSuccess(decodedText),
            () => {} // تجاهل أخطاء الإطارات الفارغة
          );
          startedWith = candidate;
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!startedWith) {
        throw lastError || new Error('تعذّر تشغيل الكاميرا.');
      }

      this.isScanning = true;
      this.currentCameraId = typeof startedWith === 'string'
        ? startedWith
        : (this.cameras[0] ? this.cameras[0].id : null);

      // تحديث الواجهة
      this.els.qrPlaceholder.hidden = true;
      this.els.viewportWrap.classList.add('is-scanning');
      this.els.scannerBadge.textContent = 'يمسح الآن...';
      this.els.scannerBadge.className = 'status-badge status-active';

      this.els.btnStart.hidden = true;
      this.els.btnStop.hidden = false;
      this.els.btnSwitch.hidden = !(this.cameras && this.cameras.length > 1);

      this.els.statusBar.textContent = this._formatCameraStatus(this.currentCameraId);
    } catch (err) {
      console.error('Camera start error:', err);
      this.els.statusBar.textContent = '⚠️ تعذّر تشغيل الكاميرا. تأكد من منح الصلاحية للمتصفح.';
      this.showToast('تعذّر الوصول إلى الكاميرا. تحقق من الأذونات.', 'error');
    } finally {
      this.isStarting = false;
      this.els.btnStart.disabled = false;
    }
  },

  async stopCamera() {
    if (this.isStarting || !this.isScanning || !this.html5QrCode) return;
    this.isStarting = true;
    try {
      await this.html5QrCode.stop();
      await this.html5QrCode.clear();
    } catch (err) {
      console.warn('Stop camera warning:', err);
    } finally {
      this.isScanning = false;
      this.isStarting = false;

      this.els.qrPlaceholder.hidden = false;
      this.els.viewportWrap.classList.remove('is-scanning');
      this.els.scannerBadge.textContent = 'متوقف';
      this.els.scannerBadge.className = 'status-badge status-idle';

      this.els.btnStart.hidden = false;
      this.els.btnStop.hidden = true;
      this.els.btnSwitch.hidden = true;

      this.els.statusBar.textContent = 'الكاميرا متوقفة حالياً.';
    }
  },

  async switchCamera() {
    if (this.isStarting || !this.isScanning || this.cameras.length < 2) return;

    const currentIdx = this.cameras.findIndex(c => c.id === this.currentCameraId);
    const nextIdx = (currentIdx + 1) % this.cameras.length;
    const nextCam = this.cameras[nextIdx];

    this.preferredCameraId = nextCam.id;
    await this.stopCamera();
    await this.startCamera(nextCam.id);
  },

  /* ========================================================================
     التحقق الصارم من الرمز الممسوح (رفض الروابط والرموز، ومنع التكرار)
     ======================================================================== */
  isValidStudentId(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return { valid: false, reason: 'رمز فارغ' };
    }

    const text = rawText.trim();
    if (!text) {
      return { valid: false, reason: 'رمز فارغ' };
    }

    // 1. فحص صريح للروابط أو الإيميلات أو النقاط أو الفواصل أو @
    const lower = text.toLowerCase();
    if (
      lower.startsWith('http://') ||
      lower.startsWith('https://') ||
      lower.startsWith('www.') ||
      /[.,@/:?&=+#%\s]/.test(text)
    ) {
      return {
        valid: false,
        isUrlOrInvalidSymbol: true,
        reason: '⚠️ تحذير: هذا الرمز رابط أو يحوي رموزاً غير مسموحة وليس معرّف (ID)!'
      };
    }

    // 2. القاعدة الصارمة: مسموح فقط حروف إنجليزية وأرقام والشرطة (-)
    // ولا يبدأ أو ينتهي بشرطة، ويحوي رقماً واحداً على الأقل
    if (!/^[A-Za-z0-9-]+$/.test(text) || /^[-]|[-]$|--/.test(text) || !/\d/.test(text)) {
      return {
        valid: false,
        isUrlOrInvalidSymbol: true,
        reason: '⚠️ تحذير: هذا الرمز ليس معرّف (ID) صالحاً!'
      };
    }

    return {
      valid: true,
      normalizedId: text.toUpperCase()
    };
  },

  onScanSuccess(decodedText) {
    const now = Date.now();
    const cleanRaw = (decodedText || '').trim();

    // التحقق من صلاحية الـ ID
    const check = this.isValidStudentId(cleanRaw);

    if (!check.valid) {
      // تهدئة 1.6 ثانية لنفس الرمز المرفوض حتى لا تغرق الشاشة بالتنبيهات
      if (this.lastAlertCode === cleanRaw && now - this.lastAlertTime < 1600) {
        return;
      }
      this.lastAlertCode = cleanRaw;
      this.lastAlertTime = now;

      this.flashViewport('err');
      this.playBeep('error');
      this.showToast(check.reason, 'error');
      return;
    }

    const id = check.normalizedId;

    // منع تكرار المعرّف القديم في نفس الجلسة
    if (this.scannedSet.has(id)) {
      if (this.lastAlertCode === id && now - this.lastAlertTime < 1500) {
        return;
      }
      this.lastAlertCode = id;
      this.lastAlertTime = now;

      this.showToast(`المعرّف ${id} ممسوح مسبقاً (لم يُكرّر)`, 'warning');
      return;
    }

    // إضافة المعرّف الجديد فوراً
    this.scannedSet.add(id);
    this.scannedList.push(id);
    this.lastAlertCode = id;
    this.lastAlertTime = now;

    this.flashViewport('ok');
    this.playBeep('success');
    this.renderOutput();
    this.showToast(`✅ تمت قراءة: ${id}`, 'success', 1400);
  },

  flashViewport(type) {
    const cls = type === 'ok' ? 'scan-flash-ok' : 'scan-flash-err';
    this.els.viewportWrap.classList.add(cls);
    setTimeout(() => {
      this.els.viewportWrap.classList.remove(cls);
    }, 280);
  },

  /* ========================================================================
     تجميع النص وإدارة المعرّفات الممسوحة
     ======================================================================== */
  formatIdForOutput(id) {
    const keepHyphen = this.els.chkKeepHyphen.checked;
    return keepHyphen ? id : id.replace(/-/g, '');
  },

  renderOutput() {
    const count = this.scannedList.length;
    const lastId = count > 0 ? this.scannedList[count - 1] : '—';

    this.els.statCount.textContent = String(count);
    this.els.statLastId.textContent = lastId;

    // بناء النص المتصل وراء بعضه مباشرة بدون مسافات
    const concatenated = this.scannedList
      .map(id => this.formatIdForOutput(id))
      .join('');

    this.els.outputText.value = concatenated;
    this.els.charCounter.textContent = `${concatenated.length} حرف`;

    const hasItems = count > 0;
    this.els.btnCopy.disabled = !hasItems;
    this.els.btnUndo.disabled = !hasItems;
    this.els.btnClear.disabled = !hasItems;
    this.els.chipsSection.hidden = !hasItems;

    // رسم الشرائح المصغّرة
    this.els.scannedChips.innerHTML = '';
    this.scannedList.forEach((id) => {
      const chip = document.createElement('span');
      chip.className = 'id-chip';

      const txt = document.createElement('span');
      txt.textContent = id;

      const btnRemove = document.createElement('button');
      btnRemove.type = 'button';
      btnRemove.className = 'id-chip-remove';
      btnRemove.title = `حذف ${id}`;
      btnRemove.setAttribute('aria-label', `حذف ${id}`);
      btnRemove.textContent = '×';
      btnRemove.addEventListener('click', () => this.removeSingleId(id));

      chip.appendChild(txt);
      chip.appendChild(btnRemove);
      this.els.scannedChips.appendChild(chip);
    });
  },

  removeSingleId(id) {
    if (!this.scannedSet.has(id)) return;
    this.scannedSet.delete(id);
    this.scannedList = this.scannedList.filter(item => item !== id);
    this.renderOutput();
    this.showToast(`تم حذف ${id}`, 'warning', 1400);
  },

  undoLastId() {
    if (this.scannedList.length === 0) return;
    const removed = this.scannedList.pop();
    this.scannedSet.delete(removed);
    this.renderOutput();
    this.showToast(`↩️ تم التراجع عن: ${removed}`, 'warning', 1500);
  },

  clearAllIds() {
    if (this.scannedList.length === 0) return;
    if (!window.confirm('هل أنت متأكد من مسح جميع المعرّفات المجمّعة والبدء من جديد؟')) {
      return;
    }
    this.scannedList = [];
    this.scannedSet.clear();
    this.lastAlertCode = '';
    this.renderOutput();
    this.showToast('🗑️ تم تصفير القائمة بالكامل', 'warning', 1600);
  },

  async copyAllText() {
    const text = this.els.outputText.value;
    if (!text) return;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        this.els.outputText.select();
        document.execCommand('copy');
      }
      this.showToast(`📋 تم نسخ ${this.scannedList.length} معرّف إلى الحافظة!`, 'success');
    } catch (err) {
      this.showToast('تعذّر النسخ التلقائي، يرجى تحديد النص ونسخه يدوياً.', 'error');
    }
  },

  /* ========================================================================
     التنبيهات الصوتية والمرئية
     ======================================================================== */
  playBeep(type = 'success') {
    if (!this.els.chkSound || !this.els.chkSound.checked) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!this.audioCtx) {
        this.audioCtx = new AudioContextClass();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      const now = this.audioCtx.currentTime;
      if (type === 'success') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.start(now);
        osc.stop(now + 0.09);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch (_) {}
  },

  showToast(message, type = 'success', duration = 2600) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    this.els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.2s ease';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  },

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
    }
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
