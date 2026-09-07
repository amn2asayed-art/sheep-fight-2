import os
import math
import numpy as np
from PIL import Image, ImageFilter, ImageOps, ImageDraw

BRAIN_DIR = r"C:\Users\islam\.gemini\antigravity\brain\91c28132-f40f-4d6d-b08d-ca1bdcc0f9d0"
BASE_DIR = os.getcwd()

def extract_chroma_green(img_path):
    """Isolates content from green chroma key (#00FF00)."""
    im = Image.open(img_path).convert("RGBA")
    data = np.array(im, dtype=np.float32)
    r, g, b = data[:, :, 0], data[:, :, 1], data[:, :, 2]
    
    # Green dominance metric
    greenness = g - np.maximum(r, b)
    alpha = np.clip(1.0 - (greenness - 20.0) / 30.0, 0.0, 1.0) * 255.0
    data[:, :, 3] = alpha
    
    # Spill suppression
    mask = greenness > 0
    data[mask, 1] = np.maximum(r[mask], b[mask])
    
    return Image.fromarray(data.astype(np.uint8), mode="RGBA")

def extract_white_bg(img_path):
    """Isolates content from white/off-white background."""
    im = Image.open(img_path).convert("RGBA")
    data = np.array(im, dtype=np.float32)
    r, g, b = data[:, :, 0], data[:, :, 1], data[:, :, 2]
    
    dist = np.sqrt((255.0 - r)**2 + (255.0 - g)**2 + (255.0 - b)**2)
    alpha = np.clip((dist - 15.0) / 30.0, 0.0, 1.0) * 255.0
    data[:, :, 3] = alpha
    
    return Image.fromarray(data.astype(np.uint8), mode="RGBA")

def crop_content(img, margin=4):
    bbox = img.getbbox()
    if not bbox:
        return img
    x1 = max(0, bbox[0] - margin)
    y1 = max(0, bbox[1] - margin)
    x2 = min(img.width, bbox[2] + margin)
    y2 = min(img.height, bbox[3] + margin)
    return img.crop((x1, y1, x2, y2))

def create_animation_strip(base_char, total_w, total_h, num_frames=6, anim_type="walk", flip_v=False):
    """
    Generates a high-quality horizontal sprite strip with dynamic animation.
    anim_type:
      - 'walk': bobbing up/down, wing flap / leg stepping oscillation
      - 'push': head-butt thrust, strain, leaning forward
      - 'spawn': scale up from 0 to full with burst
      - 'win': victory bounce & wing spread
      - 'lose': dizzy sway
    """
    strip = Image.new("RGBA", (total_w, total_h), (0, 0, 0, 0))
    frame_w = total_w / num_frames
    
    char = crop_content(base_char)
    if flip_v:
        char = char.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        
    for i in range(num_frames):
        t = (i / num_frames) * 2 * math.pi
        frame_canvas = Image.new("RGBA", (int(round(frame_w * 2)), int(round(total_h * 2))), (0, 0, 0, 0))
        
        # Max dimensions inside each frame
        max_w = frame_w * 0.94
        max_h = total_h * 0.94
        
        scale_x = 1.0
        scale_y = 1.0
        offset_x = 0.0
        offset_y = 0.0
        rotation = 0.0
        
        if anim_type == "walk":
            # Natural rhythmic stepping & bobbing
            offset_y = math.sin(t * 2) * (total_h * 0.06)
            scale_y = 1.0 + math.sin(t * 2) * 0.05
            scale_x = 1.0 - math.sin(t * 2) * 0.03
            rotation = math.sin(t) * 3.5  # slight body sway
        elif anim_type == "push":
            # Aggressive pushing struggle / headbutting
            push_phase = (i / num_frames)
            offset_y = math.sin(push_phase * 2 * math.pi) * (total_h * 0.08)
            offset_x = math.cos(push_phase * 2 * math.pi) * (frame_w * 0.04)
            scale_x = 1.0 + math.sin(push_phase * 2 * math.pi) * 0.08
            scale_y = 1.0 - math.sin(push_phase * 2 * math.pi) * 0.05
            rotation = math.sin(push_phase * 2 * math.pi) * 6.0
        elif anim_type == "spawn":
            # Bursting into lane
            progress = (i + 1) / num_frames
            scale_x = scale_y = progress
            rotation = (1.0 - progress) * 20.0
        elif anim_type == "win":
            # Victory jump & joy
            offset_y = -abs(math.sin(t)) * (total_h * 0.15)
            scale_y = 1.0 + math.sin(t) * 0.08
            scale_x = 1.0 - math.sin(t) * 0.04
            rotation = math.sin(t) * 5.0
        elif anim_type == "lose":
            # Defeat / dizzy sway
            rotation = math.sin(t) * 12.0
            scale_y = 0.9 + math.sin(t * 2) * 0.04
            offset_y = total_h * 0.06
            
        # Target size
        cur_w = max(4, int(round(max_w * scale_x)))
        cur_h = max(4, int(round(max_h * scale_y)))
        
        # Resize preserving aspect ratio inside box
        resized = char.copy()
        resized.thumbnail((cur_w, cur_h), Image.Resampling.LANCZOS)
        
        if abs(rotation) > 0.5:
            resized = resized.rotate(rotation, resample=Image.Resampling.BICUBIC, expand=True)
            
        # Paste centered in frame_canvas
        fx = int((frame_canvas.width - resized.width) / 2.0 + offset_x)
        fy = int((frame_canvas.height - resized.height) / 2.0 + offset_y)
        frame_canvas.paste(resized, (fx, fy), resized)
        
        # Crop back to single frame size and paste on strip
        cx = int((frame_canvas.width - frame_w) / 2.0)
        cy = int((frame_canvas.height - total_h) / 2.0)
        final_frame = frame_canvas.crop((cx, cy, cx + int(round(frame_w)), cy + total_h))
        
        strip_x = int(round(i * frame_w))
        strip.paste(final_frame, (strip_x, 0), final_frame)
        
    return strip

def create_card_icon(char_img, target_w, target_h):
    """Creates a clean card icon for the bottom lane buttons."""
    icon = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    char = crop_content(char_img)
    # Fit into target dimensions
    resized = char.copy()
    resized.thumbnail((target_w - 2, target_h - 2), Image.Resampling.LANCZOS)
    
    ox = (target_w - resized.width) // 2
    oy = (target_h - resized.height) // 2
    icon.paste(resized, (ox, oy), resized)
    return icon

def process_all():
    print("--- Starting Asset Pipeline ---")
    
    # 1. TITLE & BRANDING
    title_src = os.path.join(BRAIN_DIR, "chicken_battles_title_1788736225127.jpg")
    print("Processing Title Logo:", title_src)
    title_rgba = extract_white_bg(title_src)
    title_cropped = crop_content(title_rgba, margin=10)
    
    # Target 410x179
    title_target = Image.new("RGBA", (410, 179), (0, 0, 0, 0))
    resized_title = title_cropped.copy()
    resized_title.thumbnail((400, 170), Image.Resampling.LANCZOS)
    title_target.paste(resized_title, ((410 - resized_title.width) // 2, (179 - resized_title.height) // 2), resized_title)
    title_dest = os.path.join("media", "graphics", "game", "gui", "title.png")
    os.makedirs(os.path.dirname(title_dest), exist_ok=True)
    title_target.save(title_dest)
    print("Saved:", title_dest)
    
    # Splash & Branding Logo
    splash_dest = os.path.join("branding", "splash1.png")
    os.makedirs(os.path.dirname(splash_dest), exist_ok=True)
    splash_target = Image.new("RGBA", (480, 240), (0, 0, 0, 0))
    splash_img = title_cropped.copy()
    splash_img.thumbnail((460, 220), Image.Resampling.LANCZOS)
    splash_target.paste(splash_img, ((480 - splash_img.width) // 2, (240 - splash_img.height) // 2), splash_img)
    splash_target.save(splash_dest)
    print("Saved:", splash_dest)
    
    logo_dest = os.path.join("branding", "logo.png")
    logo_target = Image.new("RGBA", (166, 61), (0, 0, 0, 0))
    logo_img = title_cropped.copy()
    logo_img.thumbnail((160, 55), Image.Resampling.LANCZOS)
    logo_target.paste(logo_img, ((166 - logo_img.width) // 2, (61 - logo_img.height) // 2), logo_img)
    logo_target.save(logo_dest)
    print("Saved:", logo_dest)
    
    # 2. BACKGROUND & LOADING BG
    bg_src = os.path.join(BRAIN_DIR, "chicken_game_bg_1788736253046.jpg")
    print("Processing Background:", bg_src)
    bg_im = Image.open(bg_src).convert("RGB")
    bg_resized = bg_im.resize((540, 960), Image.Resampling.LANCZOS)
    bg_dest = os.path.join("media", "graphics", "game", "gui", "bg.png")
    bg_resized.save(bg_dest)
    print("Saved:", bg_dest)
    
    # Loading bar bg (460x62) - sample a nice wooden textured bar from bg
    loading_dest = os.path.join("media", "graphics", "game", "gui", "loadingbg.png")
    # Take a horizontal slice of the wooden fence area from bg
    fence_slice = bg_resized.crop((40, 700, 500, 762))
    fence_slice.save(loading_dest)
    print("Saved:", loading_dest)
    
    # 3. AVATARS (485x98: 5 avatars of 97x98 each)
    avatar_src = os.path.join(BRAIN_DIR, "chicken_avatars_1788736609691.jpg")
    print("Processing Avatars:", avatar_src)
    avatars_rgba = extract_chroma_green(avatar_src)
    
    # The 5 avatar bounding boxes identified:
    # 1: (55, 77, 402, 412) - Rocker with sunglasses
    # 2: (458, 77, 837, 412) - Ninja chicken
    # 3: (862, 77, 1209, 412) - Viking rooster
    # 4: (224, 436, 612, 780) - Boxer rooster
    # 5: (670, 436, 1058, 780) - King rooster
    avatar_boxes = [
        (55, 77, 402, 412),
        (458, 77, 837, 412),
        (862, 77, 1209, 412),
        (224, 436, 612, 780),
        (670, 436, 1058, 780)
    ]
    avatar_strip = Image.new("RGBA", (485, 98), (0, 0, 0, 0))
    slot_w = 485 // 5  # 97
    for i, box in enumerate(avatar_boxes):
        single = crop_content(avatars_rgba.crop(box))
        single.thumbnail((88, 88), Image.Resampling.LANCZOS)
        ox = i * slot_w + (slot_w - single.width) // 2
        oy = (98 - single.height) // 2
        avatar_strip.paste(single, (ox, oy), single)
    avatar_dest = os.path.join("media", "graphics", "game", "avatars", "avatar.png")
    avatar_strip.save(avatar_dest)
    print("Saved:", avatar_dest)
    
    # 4. WHITE CHICKEN TEAM (5 Levels)
    white_src = os.path.join(BRAIN_DIR, "white_chickens_set_1788736424110.jpg")
    print("Processing White Chicken Team:", white_src)
    white_rgba = extract_chroma_green(white_src)
    
    # Boxes for White Chickens:
    # Level 1 (Chick): (34, 245, 173, 432)
    # Level 2 (Hen): (214, 188, 390, 435)
    # Level 3 (Fighting Rooster): (417, 119, 687, 435)
    # Level 4 (Boxer Rooster): (19, 545, 361, 934)
    # Level 5 (King Boss Rooster): (687, 492, 1011, 938)
    white_char_boxes = [
        (34, 245, 173, 432),
        (214, 188, 390, 435),
        (417, 119, 687, 435),
        (19, 545, 361, 934),
        (687, 492, 1011, 938)
    ]
    white_chars = [crop_content(white_rgba.crop(b)) for b in white_char_boxes]
    
    # Dimensions for White Sheep:
    # lvl1: walk=(204, 42), push=(204, 42), card=(30, 34)
    # lvl2: walk=(301, 47), push=(295, 47), card=(35, 31)
    # lvl3: walk=(336, 59), push=(336, 59), card=(35, 34)
    # lvl4: walk=(367, 72), push=(367, 72), card=(35, 37)
    # lvl5: walk=(493, 84), push=(493, 84), card=(35, 32)
    white_dims = [
        {"walk": (204, 42), "push": (204, 42), "card": (30, 34)},
        {"walk": (301, 47), "push": (295, 47), "card": (35, 31)},
        {"walk": (336, 59), "push": (336, 59), "card": (35, 34)},
        {"walk": (367, 72), "push": (367, 72), "card": (35, 37)},
        {"walk": (493, 84), "push": (493, 84), "card": (35, 32)}
    ]
    
    for lvl in range(1, 6):
        ch = white_chars[lvl - 1]
        dims = white_dims[lvl - 1]
        
        # Walk strip
        w_strip = create_animation_strip(ch, dims["walk"][0], dims["walk"][1], num_frames=6, anim_type="walk")
        w_path = os.path.join("media", "graphics", "game", "sheep", f"sheep-{lvl}-w-walk.png")
        w_strip.save(w_path)
        
        # Push strip
        p_strip = create_animation_strip(ch, dims["push"][0], dims["push"][1], num_frames=6, anim_type="push")
        p_path = os.path.join("media", "graphics", "game", "sheep", f"sheep-{lvl}-w-push.png")
        p_strip.save(p_path)
        
        # Card Icon
        card = create_card_icon(ch, dims["card"][0], dims["card"][1])
        c_path = os.path.join("media", "graphics", "game", f"lvl{lvl}W.png")
        card.save(c_path)
        
        print(f"Saved White Tier {lvl}: walk {dims['walk']}, push {dims['push']}, card {dims['card']}")
        
    # 5. BLACK CHICKEN TEAM (5 Levels)
    black_src = os.path.join(BRAIN_DIR, "black_chickens_set_1788736480604.jpg")
    print("Processing Black Chicken Team:", black_src)
    black_rgba = extract_chroma_green(black_src)
    
    # Boxes for Black Chickens:
    # Level 1 (Chick): (86, 277, 218, 444)
    # Level 2 (Hen): (333, 203, 550, 448)
    # Level 3 (Athletic Rooster): (619, 109, 938, 449)
    # Level 4 (Brawler Rooster): (45, 549, 494, 954)
    # Level 5 (Warlord Rooster): (533, 535, 989, 954)
    black_char_boxes = [
        (86, 277, 218, 444),
        (333, 203, 550, 448),
        (619, 109, 938, 449),
        (45, 549, 494, 954),
        (533, 535, 989, 954)
    ]
    black_chars = [crop_content(black_rgba.crop(b)) for b in black_char_boxes]
    
    # Dimensions for Black Sheep:
    # lvl1: walk=(222, 43), push=(205, 42), card=(31, 35)
    # lvl2: walk=(301, 50), push=(301, 47), card=(36, 32)
    # lvl3: walk=(318, 60), push=(336, 57), card=(36, 35)
    # lvl4: walk=(367, 72), push=(367, 72), card=(36, 38)
    # lvl5: walk=(498, 83), push=(498, 80), card=(36, 34)
    black_dims = [
        {"walk": (222, 43), "push": (205, 42), "card": (31, 35)},
        {"walk": (301, 50), "push": (301, 47), "card": (36, 32)},
        {"walk": (318, 60), "push": (336, 57), "card": (36, 35)},
        {"walk": (367, 72), "push": (367, 72), "card": (36, 38)},
        {"walk": (498, 83), "push": (498, 80), "card": (36, 34)}
    ]
    
    for lvl in range(1, 6):
        ch = black_chars[lvl - 1]
        dims = black_dims[lvl - 1]
        
        # Walk strip
        w_strip = create_animation_strip(ch, dims["walk"][0], dims["walk"][1], num_frames=6, anim_type="walk")
        w_path = os.path.join("media", "graphics", "game", "sheep", f"sheep-{lvl}-b-walk.png")
        w_strip.save(w_path)
        
        # Push strip
        push_frames = 5 if lvl == 1 else 6
        p_strip = create_animation_strip(ch, dims["push"][0], dims["push"][1], num_frames=push_frames, anim_type="push")
        p_path = os.path.join("media", "graphics", "game", "sheep", f"sheep-{lvl}-b-push.png")
        p_strip.save(p_path)
        
        # Card Icon
        card = create_card_icon(ch, dims["card"][0], dims["card"][1])
        c_path = os.path.join("media", "graphics", "game", f"lvl{lvl}B.png")
        card.save(c_path)
        
        print(f"Saved Black Tier {lvl}: walk {dims['walk']}, push {dims['push']}, card {dims['card']}")
        
    # 6. NEUTRAL GOLDEN ROOSTER
    gold_src = os.path.join(BRAIN_DIR, "golden_rooster_neutral_1788736544240.jpg")
    print("Processing Golden Rooster:", gold_src)
    gold_rgba = extract_chroma_green(gold_src)
    gold_char = crop_content(gold_rgba)
    
    # neutral-spawn.png: (465, 70), 5 frames
    spawn_strip = create_animation_strip(gold_char, 465, 70, num_frames=5, anim_type="spawn")
    spawn_strip.save(os.path.join("media", "graphics", "game", "sheep", "neutral-spawn.png"))
    
    # neutral-idle.png: (630, 77), 6 frames
    idle_strip = create_animation_strip(gold_char, 630, 77, num_frames=6, anim_type="walk")
    idle_strip.save(os.path.join("media", "graphics", "game", "sheep", "neutral-idle.png"))
    
    # neutral-win.png: (630, 77), 6 frames
    win_strip = create_animation_strip(gold_char, 630, 77, num_frames=6, anim_type="win")
    win_strip.save(os.path.join("media", "graphics", "game", "sheep", "neutral-win.png"))
    
    # neutral-lose.png: (630, 77), 6 frames
    lose_strip = create_animation_strip(gold_char, 630, 77, num_frames=6, anim_type="lose")
    lose_strip.save(os.path.join("media", "graphics", "game", "sheep", "neutral-lose.png"))
    print("Saved all Neutral Golden Rooster states!")
    
    # 7. SPECIAL EFFECTS & INDICATORS
    # sheep-ready.png (50, 49) - Golden rooster head / comb icon
    ready_target = Image.new("RGBA", (50, 49), (0, 0, 0, 0))
    ready_icon = crop_content(gold_char)
    ready_icon.thumbnail((46, 45), Image.Resampling.LANCZOS)
    ready_target.paste(ready_icon, ((50 - ready_icon.width) // 2, (49 - ready_icon.height) // 2), ready_icon)
    ready_target.save(os.path.join("media", "graphics", "game", "sheep-ready.png"))
    print("Saved sheep-ready.png")
    
    # sheep-effect.png (330, 66) - 5 frames of feather burst
    effect_strip = Image.new("RGBA", (330, 66), (0, 0, 0, 0))
    # Draw nice expanding feather puffs across 5 frames
    feathers = [
        (255, 215, 0, 240), # Gold
        (230, 50, 50, 240),  # Red
        (250, 250, 250, 240) # White
    ]
    np.random.seed(42)
    fw = 330 // 5
    for fi in range(5):
        f_im = Image.new("RGBA", (fw, 66), (0, 0, 0, 0))
        draw = ImageDraw.Draw(f_im)
        radius = (fi + 1) * 6
        n_feathers = (fi + 1) * 4
        cx, cy = fw // 2, 33
        for k in range(n_feathers):
            angle = (k / n_feathers) * 2 * math.pi + (fi * 0.3)
            dist = radius * (0.6 + 0.5 * (k % 3))
            px = cx + math.cos(angle) * dist
            py = cy + math.sin(angle) * dist
            col = feathers[k % len(feathers)]
            # Draw elongated feather ellipse
            fx1 = px - 3
            fy1 = py - 6
            fx2 = px + 3
            fy2 = py + 6
            draw.ellipse([fx1, fy1, fx2, fy2], fill=col)
        effect_strip.paste(f_im, (fi * fw, 0), f_im)
    effect_strip.save(os.path.join("media", "graphics", "game", "sheep-effect.png"))
    print("Saved sheep-effect.png")
    
    print("\n--- ALL GAME GRAPHICS SUCCESSFULLY BUILT AND REPLACED ---")

if __name__ == "__main__":
    process_all()
