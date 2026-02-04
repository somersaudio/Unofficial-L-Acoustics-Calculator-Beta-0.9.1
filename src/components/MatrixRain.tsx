import { useEffect, useRef } from 'react';

interface MatrixRainProps {
  /** Text content to use for falling characters */
  text?: string;
  /** Opacity of the effect (0-1) */
  opacity?: number;
  /** Number of characters in each trail */
  trailLength?: number;
}

interface Drop {
  y: number;
  speed: number;
  chars: string[]; // Characters for the trail
  greenShade: number;
}

/**
 * Matrix-style falling text rain effect
 * Uses darkening text trails instead of fade overlay
 */
export default function MatrixRain({ text, opacity = 0.15, trailLength = 20 }: MatrixRainProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Characters to use - either from provided text or default set
    const chars = text
      ? text.replace(/\s+/g, '').split('')
      : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()+-=[]{}|;:,.<>?'.split('');

    // Configuration
    const fontSize = 14;
    const columnWidth = fontSize;

    // Resize handler
    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();

    // Initialize columns
    let columns = Math.floor(canvas.width / columnWidth);
    let drops: Drop[] = [];

    // Generate a random character
    const randomChar = () => chars[Math.floor(Math.random() * chars.length)];

    // Generate initial trail characters
    const generateTrailChars = () => {
      const trail: string[] = [];
      for (let i = 0; i < trailLength; i++) {
        trail.push(randomChar());
      }
      return trail;
    };

    const initDrops = () => {
      columns = Math.floor(canvas.width / columnWidth);
      drops = [];
      for (let i = 0; i < columns; i++) {
        drops[i] = {
          y: Math.random() * -50, // Start above screen
          speed: (0.5 + Math.random() * 1.5) / 8, // 1/8 speed
          chars: generateTrailChars(),
          greenShade: Math.floor(Math.random() * 6),
        };
      }
    };
    initDrops();

    // Green color variations - from bright to dark
    const getGreenColor = (baseShade: number, trailIndex: number): string => {
      // Base greens (brightest)
      const baseGreens = [
        [0, 255, 0],    // Bright green
        [0, 204, 0],    // Medium green
        [0, 153, 0],    // Dark green
        [51, 255, 51],  // Light bright green
        [0, 255, 102],  // Cyan-green
        [102, 255, 0],  // Yellow-green
      ];

      const base = baseGreens[baseShade % baseGreens.length];

      // Calculate darkness based on trail position (0 = head, brightest)
      const darkenFactor = 1 - (trailIndex / trailLength);
      const r = Math.floor(base[0] * darkenFactor);
      const g = Math.floor(base[1] * darkenFactor);
      const b = Math.floor(base[2] * darkenFactor);

      return `rgb(${r}, ${g}, ${b})`;
    };

    const draw = () => {
      // Clear canvas completely (no trail overlay)
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const drop = drops[i];
        const headY = drop.y * fontSize;

        // Draw each character in the trail
        for (let t = 0; t < trailLength; t++) {
          const charY = headY - (t * fontSize);

          // Skip if above canvas
          if (charY < 0) continue;
          // Skip if below canvas
          if (charY > canvas.height + fontSize) continue;

          // Get color based on trail position
          const color = getGreenColor(drop.greenShade, t);
          ctx.fillStyle = color;

          // Draw character
          ctx.fillText(drop.chars[t], i * columnWidth, charY);
        }

        // Occasionally flash the head white
        if (Math.random() > 0.98) {
          ctx.fillStyle = '#ffffff';
          ctx.fillText(drop.chars[0], i * columnWidth, headY);
        }

        // Move drop down
        drop.y += drop.speed;

        // Occasionally change head character for variety
        if (Math.random() > 0.95) {
          drop.chars[0] = randomChar();
        }

        // Reset drop when trail is fully off screen
        if ((drop.y - trailLength) * fontSize > canvas.height && Math.random() > 0.975) {
          drop.y = Math.random() * -20;
          drop.speed = (0.5 + Math.random() * 1.5) / 8; // 1/8 speed
          drop.chars = generateTrailChars();
          drop.greenShade = Math.floor(Math.random() * 6);
        }
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    // Start animation
    draw();

    // Handle resize
    const handleResize = () => {
      resize();
      initDrops();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [text, trailLength]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ opacity }}
    />
  );
}
