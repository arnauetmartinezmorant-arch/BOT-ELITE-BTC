# BTC Quant Terminal 🟠

Terminal de análisis algorítmico de Bitcoin (BTC/USDT) con detección de patrones
multi-temporalidad, señales LONG/SHORT por confluencia, gestión de riesgo 2:1,
alertas sonoras + notificaciones y diario de trades.

> ⚠️ **Aviso**: Esto NO es asesoramiento financiero. Es una herramienta educativa.
> Ningún sistema acierta el 100% de las operaciones. Opera siempre con gestión de
> riesgo y nunca arriesgues lo que no puedas permitirte perder.

---

## ✨ Funcionalidades

- **Gráfico de velas en vivo** (TradingView Lightweight Charts) con EMAs y niveles.
- **7 temporalidades**: 1m, 5m, 15m, 1H, 4H, 1D, 1W.
- **Motor de señales por confluencia**: combina tendencia, EMAs, RSI, MACD,
  Estocástico, ADX, volumen, patrones y sesgo multi-temporalidad.
- **Planes de trade**: Entrada + Stop Loss (ATR + estructura) + TP1 (1:1) y TP2 (2:1).
- **Detección de patrones**: banderas, triángulos, velas japonesas, soportes/
  resistencias y **manipulación / barridos de liquidez** (stop hunts).
- **3 modos de riesgo**: Conservador, Equilibrado, Agresivo.
- **Mapa multi-temporalidad**: sesgo alcista/bajista en cada marco.
- **🔔 Alertas**: sonido (Web Audio) + notificaciones del navegador en cada señal nueva.
- **📓 Diario de trades**: registra operaciones, marca el resultado (TP2/TP1/SL/BE),
  P&L en vivo en R-múltiplos y estadísticas (win rate, R total, R medio). Se guarda
  en `localStorage`.

## 🗂️ Datos de mercado

Intenta obtener velas reales desde APIs públicas (Binance → Binance.US → OKX) directamente
desde tu navegador, sin API key. Si tu red las bloquea, usa un generador de datos
simulados realista para que la interfaz siempre funcione (verás "Simulado" en la cabecera).

---

## ▶️ Cómo abrirlo en local

La app usa **módulos ES (`import`/`export`)**, así que **no** puedes abrirla con doble
clic (`file://`) porque el navegador bloquea los módulos por seguridad (CORS).
Necesitas un pequeño servidor local. Elige UNA opción:

### Opción A — Python (suele venir preinstalado)
```bash
cd ruta/del/proyecto
python3 -m http.server 5500
```
Abre: http://localhost:5500

### Opción B — Node.js
```bash
cd ruta/del/proyecto
npx serve .
# o:  npx http-server -p 5500
```

### Opción C — VS Code
Instala la extensión **Live Server**, abre la carpeta, click derecho en
`index.html` → **Open with Live Server**.

> 💡 Para que las **notificaciones** funcionen, el navegador pedirá permiso la primera
> vez. El **sonido** se activa tras tu primera interacción con la página (política de
> autoplay de los navegadores).

---

## 📁 Estructura

```
index.html            Interfaz
css/styles.css        Estilos (tema oscuro premium, responsive)
js/
  app.js              Orquestación + gráfico + UI
  data.js             Capa de datos (Binance/OKX + fallback simulado)
  indicators.js       EMA, RSI, MACD, ATR, Bollinger, Estocástico, ADX, volumen
  patterns.js         Tendencia, S/R, banderas, triángulos, velas, manipulación
  signals.js          Motor de confluencia + planes de trade 2:1
  alerts.js           Sonido (Web Audio) + notificaciones
  journal.js          Diario de trades (localStorage) + estadísticas en R
```

## 🧠 Cómo decide el bot

Cada factor (tendencia, momentum, RSI, MACD, patrones, niveles, sesgo de marcos
superiores...) aporta un peso con dirección alcista o bajista. La suma da una
**puntuación de confluencia** y un **% de convicción**. El bot **solo** propone un
trade si ambos superan el umbral del modo de riesgo elegido; si no, muestra
**"SIN TRADE"**. Por eso la mayoría del tiempo espera: la disciplina es la ventaja.

---

Hecho con 🧡 para fines educativos.
