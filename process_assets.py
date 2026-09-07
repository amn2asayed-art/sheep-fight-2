import sys
import os
from PIL import Image, ImageFilter, ImageOps
import numpy as np

def remove_background(img, bg_color=None, tolerance=40, feather=2):
    """
    Removes background from image.
    If bg_color is None, samples corner pixels to determine background color.
    Supports chroma keying / color distance with smooth alpha feathering.
    """
    img = img.convert("RGBA")
    data = np.array(img, dtype=np.float32)
    
    # If bg_color not specified, sample 4 corners
    if bg_color is None:
        corners = [
            data[0, 0, :3],
            data[0, -1, :3],
            data[-1, 0, :3],
            data[-1, -1, :3]
        ]
        bg_color = np.median(corners, axis=0)
    else:
        bg_color = np.array(bg_color[:3], dtype=np.float32)
        
    # Calculate color distance to background
    diff = data[:, :, :3] - bg_color
    dist = np.sqrt(np.sum(diff ** 2, axis=2))
    
    # Create smooth alpha mask
    low = tolerance
    high = tolerance + max(feather * 10, 20)
    alpha = np.clip((dist - low) / (high - low), 0.0, 1.0) * 255.0
    
    data[:, :, 3] = alpha.astype(np.uint8)
    result = Image.fromarray(data.astype(np.uint8), mode="RGBA")
    return result

def crop_to_content(img):
    """Crops transparent bounding box"""
    bbox = img.getbbox()
    if bbox:
        return img.crop(bbox)
    return img

def create_sprite_strip(frames, target_width, target_height):
    """
    Takes a list of PIL Images (individual frames),
    resizes/pads each frame, and concatenates them horizontally
    into a single sprite strip of dimensions (target_width, target_height).
    """
    n_frames = len(frames)
    frame_w = target_width / n_frames
    frame_h = target_height
    
    strip = Image.new("RGBA", (target_width, target_height), (0, 0, 0, 0))
    
    for i, frame in enumerate(frames):
        f = frame.copy()
        target_fw = int(round(frame_w))
        f.thumbnail((target_fw - 2, frame_h - 2), Image.Resampling.LANCZOS)
        
        # Center in frame
        ox = int(round(i * frame_w + (frame_w - f.width) / 2.0))
        oy = int((frame_h - f.height) // 2)
        strip.paste(f, (ox, oy), f)
        
    return strip

if __name__ == "__main__":
    print("Asset processing script loaded successfully.")
